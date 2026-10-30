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
  const [students, balances, payments, attendance, admissions] = await Promise.all([
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
  ]);
  return {from,to,generatedAt:new Date().toISOString(),students:students.rows,
    balances:balances.rows[0],payments:payments.rows,attendance:attendance.rows,admissions:admissions.rows};
}
