import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
test('server serves prototype and rejects missing files',async()=>{
 const child=spawn(process.execPath,['apps/school-web/server.mjs'],{env:{...process.env,PORT:'3107'}});
 try {
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(Error('Server exited '+code)));});
  const index=await fetch('http://127.0.0.1:3107/');
  assert.equal(index.status,200);assert.match(await index.text(),/Sign in to your school/);
  assert.match(index.headers.get('content-security-policy'),/script-src 'self'/);
  const health=await fetch('http://127.0.0.1:3107/api/health');
  assert.equal(health.status,503);
  assert.deepEqual(await health.json(),{status:'degraded',database:{ok:false,configured:false,error:'DATABASE_URL is not configured'}});
  assert.equal((await fetch('http://127.0.0.1:3107/domain.js')).status,200);
  assert.equal((await fetch('http://127.0.0.1:3107/missing.txt')).status,404);
 } finally {child.kill();}
});
test('cancellation lifecycle requires confirmation and records retention dates',async()=>{
 const [server,schema,app]=await Promise.all([
  readFile('apps/school-web/server.mjs','utf8'),
  readFile('apps/school-web/database/schema.sql','utf8'),
  readFile('apps/school-web/public/app.js','utf8'),
 ]);
 assert.match(server,/confirmation !== context\.name/);
 assert.match(server,/now\(\) \+ interval '3 months'/);
 assert.match(schema,/CREATE TABLE IF NOT EXISTS school_data_deletions/);
 assert.match(app,/Request immediate permanent deletion/);
 assert.match(app,/Permanently delete/);
});
test('self-onboarding creates an invited workspace and starts trials only after activation',async()=>{
 const [server,schema,onboarding]=await Promise.all([
  readFile('apps/school-web/server.mjs','utf8'),
  readFile('apps/school-web/database/schema.sql','utf8'),
  readFile('apps/school-web/public/onboarding.html','utf8'),
 ]);
 assert.match(onboarding,/value="self_service"/);
 assert.match(onboarding,/Request onboarding assistance/);
 assert.match(server,/status,onboarding_mode,trial_requested/);
 assert.match(server,/pg_advisory_xact_lock\(20261002\)/);
 assert.match(server,/trialCount < 10/);
 assert.match(server,/now\(\) \+ interval '3 months'/);
 assert.match(schema,/trial_ends_at timestamptz/);
});
test('onboarding displays a clear validation error instead of silently stopping',async()=>{
 const [html,script]=await Promise.all([
  readFile('apps/school-web/public/onboarding.html','utf8'),
  readFile('apps/school-web/public/onboarding.js','utf8'),
 ]);
 assert.match(html,/id="onboarding-request-form" novalidate/);
 assert.match(script,/form\.checkValidity\(\)/);
 assert.match(script,/both Data Import choices/);
 assert.match(script,/scrollIntoView/);
});
