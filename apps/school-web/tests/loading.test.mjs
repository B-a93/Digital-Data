import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const app=await readFile('apps/school-web/public/app.js','utf8');
const helpers=app.slice(app.indexOf('async function runSchoolLoads('),app.indexOf('const attentionAttendanceLoaded = new Set();'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('school loader bounds concurrency and settles every read before rejecting',async()=>{
 const ctx={};runInNewContext(helpers,ctx);
 let active=0,peak=0,finished=0;const releases=[];
 const failure=Error('sample API unavailable');
 const tasks=Array.from({length:8},(_,i)=>async()=>{
  active++;peak=Math.max(peak,active);
  await new Promise(resolve=>releases.push(resolve));
  active--;finished++;if(i===0)throw failure;
 });
 let settled=false;
 const result=ctx.runSchoolLoads(tasks,3).catch(e=>e).finally(()=>{settled=true;});
 await tick();assert.equal(active,3);
 releases.shift()();await tick();assert.equal(settled,false);assert.equal(active,3);
 while(finished<8){for(const resolve of releases.splice(0))resolve();await tick();}
 assert.equal(await result,failure);assert.equal(peak,3);assert.equal(active,0);assert.equal(finished,8);
});

test('workspace preserves initialization order and role-specific reads',async()=>{
 for(const role of ['Administrator','Teacher','Finance']){
  const events=[];let studentsReady=false,periodReady=false,termsReady=false;
  const ctx={role,state:{charges:[1],payments:[1]},
   loadSchoolStudents:async()=>{events.push('students');await tick();studentsReady=true;},
   loadAcademicPeriods:async()=>{assert(studentsReady);await tick();periodReady=true;events.push('period');},
   loadResultTerms:async()=>{if(role==='Administrator')assert(periodReady);await tick();termsReady=true;},
   loadSchoolResults:async()=>{assert(termsReady);events.push('results');}
  };
  for(const name of ['loadGuardianFollowUps','loadSchoolFinance','loadAttentionAttendance','loadTimetable','loadSchoolStaff','loadSchoolActivity','loadProgrammes','loadAdmissions'])ctx[name]=async()=>{assert(studentsReady);events.push(name);await tick();};
  runInNewContext(helpers,ctx);await ctx.loadSchoolWorkspace();assert.equal(events[0],'students');
  assert.equal(events.includes('loadSchoolFinance'),role!=='Teacher');
  assert.equal(events.includes('loadAdmissions'),role==='Administrator');
  assert.equal(events.includes('results'),role!=='Finance');
  if(role==='Teacher'){assert.equal(ctx.state.charges.length,0);assert.equal(ctx.state.payments.length,0);}
 }
});

test('parallel attendance reads retain marks from every class',async()=>{
 const ctx={schoolDataLive:true,selectedDate:'2026-10-29',selectedClass:'A',state:{students:[{id:'1',class:'A'},{id:'2',class:'B'}],attendance:{}},schoolApi:async url=>{await tick();return {marks:url.endsWith('class=A')?{'1':'present'}:{'2':'absent'},saved:true};}};
 runInNewContext(app.slice(app.indexOf('async function loadSchoolAttendance('),app.indexOf('async function loadSchoolResults(')),ctx);
 await Promise.all(['A','B'].map(c=>ctx.loadSchoolAttendance('2026-10-29',c)));
 assert.equal(ctx.state.attendance['2026-10-29'].marks['1'],'present');
 assert.equal(ctx.state.attendance['2026-10-29'].marks['2'],'absent');
});
