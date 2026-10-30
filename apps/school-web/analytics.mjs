// Every query uses the authenticated school's ID, never a client-supplied tenant.
export function analyticsRange(from, to) {
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  if (!valid(from) || !valid(to) || from > to || (Date.parse(to)-Date.parse(from))/86400000 > 366)
    throw Object.assign(new Error('Choose a valid date range of at most 367 days.'), {status:400});
  return [from,to];
}
export async function schoolAnalytics(query, schoolId, from, to) {
  analyticsRange(from,to);
  const [students, balances, payments, attendance, admissions, absences, exams, enrolment] = await Promise.all([
    query(`SELECT COALESCE(c.name,'Unassigned') AS class_name,s.status,COUNT(*)::int AS count
      FROM students s LEFT JOIN classes c ON c.id=s.class_id AND c.school_id=s.school_id
      WHERE s.school_id=$1 GROUP BY c.name,s.status ORDER BY c.name,s.status`,[schoolId]),
    query(`WITH charges AS (
      SELECT fc.student_id,SUM(GREATEST(0,fc.amount_bututs-COALESCE((SELECT SUM(fa.amount_bututs)
        FROM fee_adjustments fa WHERE fa.charge_id=fc.id AND fa.school_id=$1),0))) AS amount
      FROM fee_charges fc WHERE fc.school_id=$1 GROUP BY fc.student_id
    ), paid AS (
      SELECT p.student_id,SUM(GREATEST(0,p.amount_bututs-COALESCE((SELECT SUM(pa.amount_bututs)
        FROM payment_adjustments pa WHERE pa.payment_id=p.id AND pa.school_id=$1),0))) AS amount
      FROM payments p WHERE p.school_id=$1 GROUP BY p.student_id
    ) SELECT COALESCE(SUM(c.amount),0) AS charged,COALESCE(SUM(p.amount),0) AS paid,
      COALESCE(SUM(GREATEST(0,COALESCE(c.amount,0)-COALESCE(p.amount,0))),0) AS outstanding,
      COUNT(*) FILTER(WHERE c.amount>COALESCE(p.amount,0))::int AS owing
      FROM students s LEFT JOIN charges c ON c.student_id=s.id LEFT JOIN paid p ON p.student_id=s.id
      WHERE s.school_id=$1`,[schoolId]),
    query(`SELECT to_char(p.paid_on,'YYYY-MM') AS month,
      SUM(GREATEST(0,p.amount_bututs-COALESCE((SELECT SUM(pa.amount_bututs)
      FROM payment_adjustments pa WHERE pa.payment_id=p.id AND pa.school_id=$1),0))) AS amount
      FROM payments p WHERE p.school_id=$1 AND p.paid_on BETWEEN $2::date AND $3::date
      GROUP BY to_char(p.paid_on,'YYYY-MM') ORDER BY month`,[schoolId,from,to]),
    query(`SELECT to_char(attendance_date,'YYYY-MM') AS month,status,COUNT(*)::int AS count
      FROM attendance WHERE school_id=$1 AND attendance_date BETWEEN $2::date AND $3::date
      GROUP BY to_char(attendance_date,'YYYY-MM'),status ORDER BY month,status`,[schoolId,from,to]),
    query(`SELECT status,COUNT(*)::int AS count FROM student_admission_applications
      WHERE school_id=$1 AND created_at >= $2::date AND created_at < $3::date + interval '1 day'
      GROUP BY status ORDER BY status`,[schoolId,from,to]),
    query(`SELECT s.id,s.student_number,s.full_name,COALESCE(c.name,'Unassigned') AS class_name,
      COUNT(*)::int AS absent_days FROM attendance a
      JOIN students s ON s.id=a.student_id AND s.school_id=a.school_id
      LEFT JOIN classes c ON c.id=s.class_id AND c.school_id=s.school_id
      WHERE a.school_id=$1 AND a.attendance_date BETWEEN $2::date AND $3::date AND a.status='absent'
      GROUP BY s.id,c.name HAVING COUNT(*)>=3 ORDER BY absent_days DESC,s.full_name`,[schoolId,from,to]),
    query(`WITH latest AS (
      SELECT DISTINCT ON (a.class_id,a.subject_id,a.academic_year,a.term) a.*
      FROM assessments a WHERE a.school_id=$1 AND a.published_at IS NOT NULL
        AND a.published_at < $3::date + interval '1 day'
      ORDER BY a.class_id,a.subject_id,a.academic_year,a.term,a.published_at DESC,a.id DESC
    ) SELECT a.academic_year,a.term,COALESCE(su.name,'General') AS subject_name,
      c.name AS class_name,s.id AS student_id,s.student_number,s.full_name,
      m.score,a.maximum_score,a.grade_scale,a.pass_mark_snapshot
      FROM latest a JOIN assessment_marks m ON m.assessment_id=a.id
      JOIN students s ON s.id=m.student_id AND s.school_id=a.school_id
      JOIN classes c ON c.id=a.class_id AND c.school_id=a.school_id
      LEFT JOIN subjects su ON su.id=a.subject_id AND su.school_id=a.school_id
      WHERE a.school_id=$1 AND a.published_at >= $2::date
      ORDER BY a.academic_year,a.term,c.name,su.name,s.full_name`,[schoolId,from,to]),
    query(`SELECT p.id,p.academic_year,p.term,p.status,p.opened_at,p.closed_at,
      COUNT(e.student_id) FILTER(WHERE e.new_status='active')::int AS active_students
      FROM academic_periods p LEFT JOIN LATERAL (
        SELECT DISTINCT ON (ev.student_id) ev.student_id,ev.new_status
        FROM student_lifecycle_events ev WHERE ev.school_id=$1
          AND ev.event_date <= COALESCE(p.closed_at,now())::date
          AND ev.created_at <= COALESCE(p.closed_at,now())
        ORDER BY ev.student_id,ev.event_date DESC,ev.created_at DESC,ev.id DESC
      ) e ON true WHERE p.school_id=$1
      GROUP BY p.id ORDER BY p.opened_at,p.id`,[schoolId]),
  ]);
  return {from,to,generatedAt:new Date().toISOString(),students:students.rows,
    balances:balances.rows[0],payments:payments.rows,attendance:attendance.rows,admissions:admissions.rows,
    collectionRate:collectionRate(balances.rows[0]),absences:absences.rows,
    exams:summarizeExams(exams.rows),enrolment:enrolment.rows.map((row,index)=>({...row,
      change:index ? Number(row.active_students)-Number(enrolment.rows[index-1].active_students) : null}))};
}

export function collectionRate(balances) {
  const charged=Number(balances?.charged || 0), outstanding=Number(balances?.outstanding || 0);
  return charged > 0 ? Math.max(0,Math.min(100,100*(charged-outstanding)/charged)) : null;
}
export function summarizeExams(rows) {
  const groups=new Map(), support=[];
  let marked=0,passed=0,unclassified=0;
  for(const row of rows) {
    const percentage=100*Number(row.score)/Number(row.maximum_score);
    if(!Number.isFinite(percentage)) continue;
    let passing=null;
    if(Array.isArray(row.grade_scale?.bands) && row.grade_scale.bands.length) {
      const bands=[...row.grade_scale.bands].sort((a,b)=>Number(b.min)-Number(a.min));
      passing=Boolean((bands.find(b=>percentage>=Number(b.min)) || bands.at(-1)).passing);
    } else if(row.pass_mark_snapshot != null) passing=percentage>=Number(row.pass_mark_snapshot);
    const key=JSON.stringify([row.academic_year,row.term,row.class_name,row.subject_name]);
    if(!groups.has(key)) groups.set(key,{academic_year:row.academic_year,term:row.term,
      class_name:row.class_name,subject_name:row.subject_name,marks:0,classified:0,passed:0,sum:0});
    const group=groups.get(key);group.marks++;group.sum+=percentage;
    if(passing===null) unclassified++;
    else {marked++;group.classified++;if(passing){passed++;group.passed++;}}
    if(passing===false) support.push({student_id:row.student_id,student_number:row.student_number,
      full_name:row.full_name,class_name:row.class_name,subject_name:row.subject_name,
      academic_year:row.academic_year,term:row.term,percentage});
  }
  return {marked,passed,unclassified,passRate:marked ? 100*passed/marked : null,support,
    subjects:[...groups.values()].map(g=>({...g,average:g.sum/g.marks,passRate:g.classified ? 100*g.passed/g.classified : null}))};
}

export function platformSubscriptionState(school, today) {
  if (['cancelled','pending_deletion','pending','suspended'].includes(school.status)) return school.status;
  if (school.billing_status === 'suspended') return 'suspended';
  const date = value => value instanceof Date ? value.toISOString().slice(0,10) : String(value || '').slice(0,10);
  if (date(school.subscription_paid_until) >= today) return 'paid';
  if (school.trial_status === 'active' && date(school.trial_ends_at) >= today) return 'trial';
  return 'uncovered';
}
export async function platformAnalytics(query, from, to) {
  analyticsRange(from,to);
  const [schools,payments,growth,clock] = await Promise.all([
    query(`SELECT id,name,status,billing_status,trial_status,trial_ends_at,subscription_paid_until,created_at
      FROM schools ORDER BY name`),
    query(`SELECT to_char(paid_on,'YYYY-MM') AS month,COUNT(*)::int AS payment_count,
      COUNT(DISTINCT school_id)::int AS paying_schools,SUM(amount_bututs) AS amount
      FROM platform_subscription_payments WHERE paid_on BETWEEN $1::date AND $2::date
      GROUP BY to_char(paid_on,'YYYY-MM') ORDER BY month`,[from,to]),
    query(`SELECT to_char(created_at,'YYYY-MM') AS month,COUNT(*)::int AS count
      FROM schools WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day'
      GROUP BY to_char(created_at,'YYYY-MM') ORDER BY month`,[from,to]),
    query(`SELECT CURRENT_DATE::text AS today`),
  ]);
  const today=clock.rows[0].today;
  const states=schools.rows.map(s=>({...s,subscription_state:platformSubscriptionState(s,today)}));
  const counts=Object.fromEntries(['paid','trial','uncovered','pending','suspended','cancelled','pending_deletion']
    .map(status=>[status,states.filter(s=>s.subscription_state===status).length]));
  return {from,to,generatedAt:new Date().toISOString(),today,totalSchools:states.length,
    activeSchools:states.filter(s=>s.status==='active').length,counts,schools:states,
    payments:payments.rows,growth:growth.rows};
}
