import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {analyticsRange,schoolAnalytics,collectionRate,summarizeExams} from '../analytics.mjs';
test('analytics validates calendar dates and bounds expensive ranges',()=>{
  assert.deepEqual(analyticsRange('2026-10-01','2026-10-31'),['2026-10-01','2026-10-31']);
  for(const range of [[null,null],['2026-02-30','2026-03-01'],['2026-11-01','2026-10-01'],['2020-01-01','2026-01-01']])
    assert.throws(()=>analyticsRange(...range),/valid date range/);
});
test('every aggregate is bound to the requested authenticated school',async()=>{
  for(const school of ['school-a','school-b']){
    const calls=[];
    const data=await schoolAnalytics(async(sql,args)=>{calls.push({sql,args});return {rows:[]};},school,'2026-10-01','2026-10-31');
    assert.equal(calls.length,8);
    for(const {sql,args} of calls){assert.equal(args[0],school);assert.match(sql,/school_id=\$1/);}
    assert.equal(calls.filter(c=>c.args.length===3).length,5);
    assert.deepEqual(data.students,[]);assert.deepEqual(data.attendance,[]);
  }
});
test('analytics route rejects unauthorized roles and ignores client school identifiers',async()=>{
  const source=await readFile('apps/school-web/server.mjs','utf8');
  const route=source.slice(source.indexOf('    if (pathname === "/api/school/analytics")'),source.indexOf('    if (pathname === "/api/school/finance")'));
  async function run(role,search='?from=2026-10-01&to=2026-10-31&school_id=other'){
    const output=[];const reads=[];
    const context={pathname:'/api/school/analytics',req:{method:'GET'},res:{},requestUrl:new URL('https://example.com/'+search),
      requireSchoolContext:async()=>({school_id:'own-school',role}),
      requireRole:(ctx,allowed)=>{if(ctx.role!==allowed)throw Error('Forbidden');},analyticsRange,query:()=>{},
      schoolAnalytics:async(q,id,from,to)=>{reads.push(id);return {from,to};},json:(res,status,data)=>output.push({status,data})};
    await vm.runInNewContext(`(async()=>{${route}})()`,context);
    return {output,reads};
  }
  for(const role of ['teacher','finance'])await assert.rejects(run(role),/Forbidden/);
  assert.deepEqual((await run('administrator')).reads,['own-school']);
  const invalid=await run('administrator','?from=bad&to=bad');
  assert.equal(invalid.output[0].status,400);assert.equal(invalid.reads.length,0);
});

test('collection rate does not count excess credit as collection and handles no charges',()=>{
  assert.equal(collectionRate({charged:10000,outstanding:2500,paid:12000}),75);
  assert.equal(collectionRate({charged:0,outstanding:0}),null);
});
test('exam analytics uses saved grade bands, normalizes scores and identifies support',()=>{
  const base={academic_year:'2026/27',term:'Term 1',class_name:'A',subject_name:'Maths',maximum_score:50,
    grade_scale:{bands:[{min:60,passing:true},{min:0,passing:false}]},pass_mark_snapshot:50};
  const result=summarizeExams([{...base,student_id:'a',score:30},{...base,student_id:'b',score:25},
    {...base,student_id:'c',score:40,grade_scale:null,pass_mark_snapshot:null}]);
  assert.equal(result.passRate,50);assert.equal(result.unclassified,1);
  assert.equal(result.support.length,1);assert.equal(result.support[0].student_id,'b');
  assert.equal(result.subjects[0].average,(60+50+80)/3);
  assert.equal(summarizeExams([]).passRate,null);
});
