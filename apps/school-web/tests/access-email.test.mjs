import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {schoolAccessMessage} from '../mailer.mjs';
test('access emails explain both actions and escape the school and reason',()=>{
 for(const action of ['suspend','reactivate']) {
  const message=schoolAccessMessage({name:'Admin',school:'A <School>',action,reason:'Review <script>fees</script>',link:'https://example.com/'});
  assert.match(message.text,/Reason: Review <script>fees<\/script>/);
  assert(!message.html.includes('<script>'));
  assert.match(message.html,/&lt;School&gt;/);
  assert.match(message.subject,action==='suspend' ? /suspended/ : /reactivated/);
  if(action==='reactivate')assert.match(message.text,/existing account/);
 }
});
test('access changes preserve the change when email fails and expose retry result',async()=>{
 const source=await readFile('apps/school-web/server.mjs','utf8');
 const route=source.slice(source.indexOf('    const billingSchool = pathname.match'),source.indexOf('    if (pathname === "/api/platform/schools")'));
 let response,sends=0;
 const queries=[];
 const context={pathname:'/api/platform/billing/schools/00000000-0000-0000-0000-000000000001',req:{method:'PATCH'},res:{},
  requirePlatformOwner:async()=>({id:'owner'}),readJsonBody:async()=>({action:'suspend',reason:'Unpaid invoice'}),randomUUID:()=> 'event-id',
  transaction:async work=>work({query:async(sql,args)=>{
   queries.push({sql,args});
   if(sql.includes('SELECT s.*'))return {rows:[{id:'school',name:'Test school',status:'active',administrator_email:'admin@example.com'}]};
   return {rows:[{id:'school',name:'Test school',status:'suspended',access_change_reason:'Unpaid invoice',access_notification_id:'event-id'}]};
  }}),query:async(sql,args)=>{queries.push({sql,args});},
  sendSchoolAccessNotification:async details=>{sends++;assert.equal(details.to,'admin@example.com');throw Error('SMTP unavailable');},
  baseUrl:()=> 'https://example.com/',json:(res,status,body)=>{response={status,body};},console:{error:()=>{}},Date};
 await vm.runInNewContext(`(async()=>{${route}})()`,context);
 assert.equal(response.status,200);assert.equal(response.body.school.status,'suspended');
 assert.equal(response.body.notificationStatus,'failed');assert.equal(sends,1);
 assert.equal(queries.at(-1).args[2],'failed');
 context.readJsonBody=async()=>({action:'reactivate',reason:' '});
 await vm.runInNewContext(`(async()=>{${route}})()`,context);
 assert.equal(response.status,400);assert.equal(sends,1);
 context.requirePlatformOwner=async()=>{throw Error('Forbidden');};
 await assert.rejects(vm.runInNewContext(`(async()=>{${route}})()`,context),/Forbidden/);
});
