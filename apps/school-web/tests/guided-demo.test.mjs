import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

// Minimal DOM adapter exercises event handlers and the shared in-memory records.
// Browser layout and rendering require a separate visual check.
async function demo(){
 const nodes=new Map();let blob;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',value:'',checked:false,disabled:false,click(){this.onclick?.();},dispatchEvent(){this.oninput?.();}});return nodes.get(id);};
 const document={getElementById:node,querySelectorAll(selector){
  const attribute=selector.slice(1,-1),key=attribute.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
  const markup=[...nodes.values()].map(n=>n.innerHTML).join('');
  return [...markup.matchAll(new RegExp(attribute+'="([^"]+)"','g'))].map(m=>{const n=node(attribute+':'+m[1]);n.dataset={[key]:m[1]};return n;});
 },createElement:()=>({click(){}})};
 runInNewContext(await readFile('apps/school-web/public/guided-demo.js','utf8'),{document,Event:class{},Blob,URL:{createObjectURL:b=>{blob=b;return 'blob:test';},revokeObjectURL(){}},setTimeout:fn=>fn(),window:{print(){}}});
 return {node,report:()=>blob};
}
test('guided demo payment updates ledger, profile and report; reset restores values',async()=>{
 const {node,report}=await demo();
 assert.match(node('screen').innerHTML,/D4,000/);
 node('sample-payment').click();node('sample-payment').click();
 assert.match(node('screen').innerHTML,/D6,000/);
 assert.match(node('screen').innerHTML,/D3,000/);
 node('data-step:1').click();node('data-profile:EX001').click();
 assert.match(node('profile').innerHTML,/Paid · D0 owed/);
 assert.match(node('profile').innerHTML,/DEMO-001/);
 node('student-search').value='unknown';node('student-search').dispatchEvent();
 assert.match(node('matches').innerHTML,/No sample student matches/);
 node('data-step:3').click();node('download-report').click();
 const csv=await report().text();
 assert.match(csv,/"EX001","Awa Jallow","Grade 5","3000","3000","0","Paid"/);
 assert.match(csv,/"TOTAL","","","9000","6000","3000",""/);
 node('reset').click();assert.match(node('screen').innerHTML,/D4,000/);
});
test('attendance priority clears only when both sample students are marked',async()=>{
 const {node}=await demo();node('data-step:2').click();node('attendance-task').click();
 node('save-sample-attendance').click();assert.match(node('feedback').textContent,/Mark both/);
 node('awa-present').checked=true;node('musa-present').checked=true;node('save-sample-attendance').click();
 assert.match(node('screen').innerHTML,/Grade 5 attendance completed/);
 assert.doesNotMatch(node('screen').innerHTML,/id="attendance-task"/);
 node('record-task').click();assert.match(node('profile').innerHTML,/Mariama Ceesay/);
 assert.match(node('profile').innerHTML,/Not recorded/);
});
