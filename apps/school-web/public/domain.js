export const classes = ['Grade 7 · A','Grade 7 · B','Grade 8 · A','Grade 9 · A'];
export function seed() {
  const names = ['Awa Demo','Lamin Sample','Fatou Example','Omar Demo','Mariama Sample','Ebrima Example','Isatou Demo','Musa Sample','Binta Example','Alieu Demo','Kaddy Sample','Sanna Example'];
  return {version:1, settings:{name:'Example Academy',term:'Term 1 · 2026/27',pass:50,classes:[...classes],feeTypes:['Term tuition']}, students:names.map((name,i)=>({id:`s${i+1}`,admission:`DEMO-${String(i+1).padStart(4,'0')}`,name, class:classes[i%4]})), attendance:{}, charges:names.map((_,i)=>({id:`c${i+1}`,studentId:`s${i+1}`,amount:150000,label:'Term tuition'})), payments:[{id:'p1',operation:'seed-1',studentId:'s1',amount:150000,reference:'DEMO-R0001',date:'2026-09-10'},{id:'p2',operation:'seed-2',studentId:'s2',amount:50000,reference:'DEMO-R0002',date:'2026-09-10'}],marks:{},published:[]};
}
export function cents(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value))) throw new Error('Enter a positive amount with at most two decimal places.');
  const [whole, fraction=''] = String(value).split('.');
  const n = Number(whole)*100 + Number(fraction.padEnd(2,'0'));
  if (!Number.isSafeInteger(n) || n <= 0 || n > 100000000) throw new Error('Amount must be between D0.01 and D1,000,000.');
  return n;
}
export function balance(state,id) {
  return state.charges.filter(c=>c.studentId===id).reduce((s,c)=>s+c.amount,0) - state.payments.filter(p=>p.studentId===id).reduce((s,p)=>s+p.amount,0);
}
export function recordPayment(state, {studentId,amount,operation,date}) {
  if (!state.students.some(s=>s.id===studentId)) throw new Error('Select a valid student.');
  if (!operation || !Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) throw new Error('Invalid payment.');
  const previous=state.payments.find(p=>p.operation===operation);
  if (previous) {
    if (previous.studentId!==studentId || previous.amount!==amount || previous.date!==date) throw new Error('Payment operation already used with different details.');
    return previous;
  }
  const payment={id:operation,operation,studentId,amount,date,reference:`DEMO-R${String(state.payments.length+1).padStart(4,'0')}`};
  state.payments.push(payment); return payment;
}
export function attendanceSummary(marks) {
  const values = Object.values(marks);
  const eligible = values.filter(v=>['present','late','absent'].includes(v));
  const attended = eligible.filter(v=>v==='present'||v==='late').length;
  return {marked:values.filter(v=>['present','late','absent','excused'].includes(v)).length,eligible:eligible.length,attended,rate:eligible.length?Math.round(attended/eligible.length*100):null};
}
export function csv(rows) {
  return rows.map(row=>row.map(value=>{
    let text=String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text)) text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  }).join(',')).join('\r\n');
}
export function publishResults(state, className) {
  const students=state.students.filter(s=>s.class===className);
  const entries=students.map(s=>({studentId:s.id,name:s.name,admission:s.admission,score:state.marks[s.id]}));
  if (!entries.length || entries.some(e=>typeof e.score!=='number'||!Number.isFinite(e.score)||e.score<0||e.score>100)) throw new Error('Enter a valid mark from 0 to 100 for every student in this class.');
  const version=state.published.filter(p=>p.class===className && p.term===state.settings.term).length+1;
  const snapshot={id:crypto.randomUUID(),class:className,term:state.settings.term,version,pass:state.settings.pass,date:new Date().toISOString(),entries};
  state.published.push(snapshot); return snapshot;
}
