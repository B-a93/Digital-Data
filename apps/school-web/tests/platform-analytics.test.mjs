import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {analyticsRange,platformSubscriptionState,platformAnalytics} from '../analytics.mjs';
test('platform status respects expiry, payment precedence and suspended access',()=>{
 const school={status:'active',trial_status:'active',trial_ends_at:'2026-10-30T12:00:00Z'};
 assert.equal(platformSubscriptionState(school,'2026-10-30'),'trial');
 assert.equal(platformSubscriptionState(school,'2026-10-31'),'uncovered');
 assert.equal(platformSubscriptionState({...school,subscription_paid_until:'2026-11-01'},'2026-10-30'),'paid');
 for(const status of ['pending','cancelled','pending_deletion','suspended'])
  assert.equal(platformSubscriptionState({...school,status,subscription_paid_until:'2026-11-01'},'2026-10-30'),status);
});
test('platform analytics counts schools independently of payment activity',async()=>{
 const calls=[];
 const data=await platformAnalytics(async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes('CURRENT_DATE'))return {rows:[{today:'2026-10-30'}]};
  if(sql.includes('FROM schools ORDER'))return {rows:[{id:'1',status:'active',subscription_paid_until:'2026-11-01'},
   {id:'2',status:'pending'},{id:'3',status:'active',trial_status:'active',trial_ends_at:'2026-11-01'}]};
  return {rows:[]};
 },'2026-10-01','2026-10-30');
 assert.equal(data.totalSchools,3);assert.equal(data.activeSchools,2);
 assert.equal(data.counts.paid,1);assert.equal(data.counts.trial,1);assert.equal(data.counts.pending,1);
 assert.deepEqual(data.payments,[]);
 assert.equal(calls.filter(c=>c.args?.length===2).length,2);
 assert(!calls.some(c=>/LIMIT 100/.test(c.sql)));
});
test('platform analytics authorizes owner before any data reads and validates dates',async()=>{
 const source=await readFile('apps/school-web/server.mjs','utf8');
 const route=source.slice(source.indexOf('    if (pathname === "/api/platform/analytics")'),source.indexOf('    if (pathname === "/api/platform/billing")'));
 let reads=0;
 const context={pathname:'/api/platform/analytics',req:{method:'GET'},res:{},
  requestUrl:new URL('https://example.com/?from=2026-10-01&to=2026-10-30'),
  requirePlatformOwner:async()=>{throw Error('Forbidden');},analyticsRange,query:()=>{},
  platformAnalytics:async()=>{reads++;return {};},json:()=>{}};
 await assert.rejects(vm.runInNewContext(`(async()=>{${route}})()`,context),/Forbidden/);
 assert.equal(reads,0);
 context.requirePlatformOwner=async()=>({});
 await vm.runInNewContext(`(async()=>{${route}})()`,context);assert.equal(reads,1);
 context.requestUrl=new URL('https://example.com/?from=invalid');
 let status;context.json=(res,value)=>status=value;
 await vm.runInNewContext(`(async()=>{${route}})()`,context);
 assert.equal(status,400);assert.equal(reads,1);
});
