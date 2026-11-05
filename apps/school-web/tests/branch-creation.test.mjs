
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../server.mjs', import.meta.url),'utf8');
const createSource = source.slice(source.indexOf('async function createSchoolBranch('), source.indexOf('const server = http.createServer'));
function harness(options={}) {
  const writes=[], mails=[];
  const context={school_id:'main',id:'owner',email:'owner@example.com',role:'administrator'};
  const body={name:'Brusubi',region:'West Coast',town:'Brusubi',adminName:'Headmaster',adminEmail:'head@example.com',phone:'123',...options.body};
  const query=async(sql,args)=>{
    writes.push({sql,args});
    if(sql.includes('SELECT s.*')) return {rows:options.revoked?[]:[{id:'main',name:'Academy',school_type:'training_centre',current_academic_year:'2026/27',current_term:'Term 1',pass_mark:50,grade_scale:{bands:[]}}]};
    if(sql.includes('SELECT g.*')) return {rows:options.outlet?[{id:'group',owner_school_id:'other'}]:[]};
    if(sql.includes('INSERT INTO school_branch_groups')) return {rows:[{id:'group',owner_school_id:'main'}]};
    if(sql.includes('lower(s.name)')) return {rows:options.duplicate?[{id:'exists'}]:[]};
    if(sql.includes('count(*)')) return {rows:[{total:options.limit?50:1}]};
    if(sql.includes('INSERT INTO schools(')) return {rows:[{id:'branch',name:body.name}]};
    if(sql.includes('INSERT INTO staff_invitations')) return {rows:[{id:'invite',role:'administrator',email:body.adminEmail}]};
    return {rows:[]};
  };
  const fn = new Function('requireSchoolContext','isPlatformOwnerEmail','requireRole','readJsonBody','invitation','transaction','selfServiceSlug','emailStaffInvitation','query','recordAudit','console',
    createSource+';return createSchoolBranch;')(
      async()=>context,()=>!!options.platform,()=>{if(options.teacher)throw Object.assign(new Error('Forbidden'),{status:403});},
      async()=>body,()=>({hash:'hashed',expiresAt:new Date()}),async cb=>cb({query}),()=> 'branch-slug',
      async record=>{mails.push(record);if(options.emailFail)throw Error('SMTP unavailable');},query,async()=>{}, {error(){}});
  return {run:()=>fn({}),writes,mails};
}
test('creates linked branch, owner membership and administrator invitation',async()=>{
 const h=harness(),r=await h.run();
 assert.equal(r.schoolId,'branch');assert.equal(r.invitationSent,true);assert.equal(h.mails[0].role,'administrator');
 assert.ok(h.writes.some(x=>x.sql.includes("INSERT INTO school_users")));
 assert.ok(h.writes.some(x=>x.sql.includes("INSERT INTO school_branch_members")));
});
for(const [name,options,status] of [
 ['platform account',{platform:true},403],['teacher',{teacher:true},403],['revoked membership',{revoked:true},403],
 ['outlet admin',{outlet:true},403],['duplicate branch',{duplicate:true},409],['branch limit',{limit:true},400],
 ['missing location',{body:{town:''}},400],['invalid administrator email',{body:{adminEmail:'bad'}},400]
]) test('rejects '+name+' before creating school',async()=>{
 const h=harness(options);await assert.rejects(h.run,{status});assert.ok(!h.writes.some(x=>x.sql.includes('INSERT INTO schools(')));
});
test('email failure keeps saved branch and gives retry instruction',async()=>{
 const h=harness({emailFail:true}),r=await h.run();
 assert.equal(r.schoolId,'branch');assert.equal(r.invitationSent,false);assert.ok(r.message.includes('resend'));
 assert.ok(h.writes.some(x=>x.sql.includes("invitation_status='email_failed'")));
});

test('workspace selection is checked against authenticated membership',async()=>{
 const block=source.slice(source.indexOf('async function requireSchoolContext('),source.indexOf('function requireRole('));
 let argsSeen;
 const fn=new Function('verifyAuthenticatedUser','query',block+';return requireSchoolContext;')(
   async()=>({id:'user',email:'user@example.com'}),async(sql,args)=>{
     argsSeen=args;assert.ok(sql.includes('s.id::text=$2'));assert.ok(sql.includes('su.auth_user_id=$1'));
     return {rows:args[1]==='allowed'?[{school_id:'allowed',role:'administrator'}]:[]};
   });
 assert.equal((await fn({headers:{'x-school-id':'allowed'}})).school_id,'allowed');
 await assert.rejects(()=>fn({headers:{'x-school-id':'unrelated'}}),{status:403});
 assert.equal(argsSeen[0],'user');assert.equal(argsSeen[1],'unrelated');
});
