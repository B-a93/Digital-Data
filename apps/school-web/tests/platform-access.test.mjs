import test from 'node:test';
import assert from 'node:assert/strict';
import {isPlatformOwnerEmail} from '../auth-server.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
test('additional owners retain the original owner and require exact email matches',()=>{
 const env={PLATFORM_OWNER_EMAIL:'primary@example.com',PLATFORM_OWNER_EMAILS:' Partner@example.com, other@example.com '};
 for(const email of ['primary@example.com','partner@example.com','OTHER@example.com']) assert.equal(isPlatformOwnerEmail(email,env),true);
 for(const email of ['',null,'partner','example.com','partner@example.com.attacker.test','stranger@example.com']) assert.equal(isPlatformOwnerEmail(email,env),false);
 assert.equal(isPlatformOwnerEmail('partner@example.com',{}),false);
 assert.equal(isPlatformOwnerEmail('partner@example.com',{PLATFORM_OWNER_EMAIL:'primary@example.com'}),false);
});
test('session discovery grants configured partners the platform role without school lookup',async()=>{
 const server=await readFile('apps/school-web/server.mjs','utf8');
 const start=server.indexOf('      const user = await verifyAuthenticatedUser(req);',server.indexOf('if (pathname === "/api/me")'));
 const code=server.slice(start,server.indexOf('      const membership = await query(',start));
 let result;
 await vm.runInNewContext(`(async()=>{${code}})()`,{
  req:{},res:{},verifyAuthenticatedUser:async()=>({id:'partner-id',email:'partner@example.com'}),
  isPlatformOwnerEmail:email=>isPlatformOwnerEmail(email,{PLATFORM_OWNER_EMAILS:'partner@example.com'}),
  json:(res,status,body)=>{result={status,body};}
 });
 assert.equal(result.status,200);assert.equal(result.body.user.role,'platform_owner');
 assert.equal(result.body.user.id,'partner-id');assert.equal(result.body.school,null);
});
