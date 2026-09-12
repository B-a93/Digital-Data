import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
test('server serves prototype and rejects missing files',async()=>{
 const child=spawn(process.execPath,['apps/school-web/server.mjs'],{env:{...process.env,PORT:'3107'}});
 try {
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(Error('Server exited '+code)));});
  const index=await fetch('http://127.0.0.1:3107/');
  assert.equal(index.status,200);assert.match(await index.text(),/Fictional data only/);
  assert.match(index.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal((await fetch('http://127.0.0.1:3107/domain.js')).status,200);
  assert.equal((await fetch('http://127.0.0.1:3107/missing.txt')).status,404);
 } finally {child.kill();}
});
