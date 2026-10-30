import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {analyticsRange,schoolAnalytics} from '../analytics.mjs';
test('analytics validates calendar dates and bounds expensive ranges',()=>{
  assert.deepEqual(analyticsRange('2026-10-01','2026-10-31'),['2026-10-01','2026-10-31']);
  for(const range of [[null,null],['2026-02-30','2026-03-01'],['2026-11-01','2026-10-01'],['2020-01-01','2026-01-01']])
    assert.throws(()=>analyticsRange(...range),/valid date range/);
});
test('every aggregate is bound to the requested authenticated school',async()=>{
  for(const school of ['school-a','school-b']){
    const calls=[];
    const data=await schoolAnalytics(async(sql,args)=>{calls.push({sql,args});return {rows:[]};},school,'2026-10-01','2026-10-31');
    assert.equal(calls.length,5);
    for(const {sql,args} of calls){assert.equal(args[0],school);assert.match(sql,/school_id=\$1/);}
    assert.equal(calls.filter(c=>c.args.length===3).length,3);
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
