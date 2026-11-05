import { query, transaction } from './database.mjs';
import { verifyAuthenticatedUser, isPlatformOwnerEmail } from './auth-server.mjs';
import { summarizeExams, collectionRate } from './analytics.mjs';

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function label(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > 120) fail('Enter a label of 1 to 120 characters.');
  return text;
}
export function comparisonKey(row) {
  return JSON.stringify([row.course,row.level,row.component,row.basis,row.academic_year,row.term]
    .map(value => String(value || '').trim().toLowerCase()));
}

export async function branchRequest(req, url, readBody) {
  const user = await verifyAuthenticatedUser(req);
  const platform = isPlatformOwnerEmail(user.email);
  if (url.pathname === '/api/branches/setup') {
    if (!platform) fail('Platform owner access required.',403);
    if (req.method !== 'POST') fail('Method not allowed',405);
    const data = await readBody(req);
    const name = label(data.name);
    const ids = [...new Set([data.ownerSchoolId,...(Array.isArray(data.schoolIds) ? data.schoolIds : [])])];
    if (ids.length < 2 || ids.length > 50 || ids.some(id => !/^[0-9a-f-]{36}$/.test(id || '')))
      fail('Select an overall owner school and between two and fifty branches.');
    return transaction(async client => {
      // Serialize group membership changes, including competing group creation.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('school-branch-setup'))");
      const schools = await client.query("SELECT id FROM schools WHERE id=ANY($1::uuid[]) AND status='active'",[ids]);
      if (schools.rows.length !== ids.length) fail('Every selected school must be active.');
      const owner = await client.query(`SELECT o.auth_user_id FROM school_onboarding o
        JOIN school_users u ON u.school_id=o.school_id AND u.auth_user_id=o.auth_user_id AND u.role='administrator'
        WHERE o.school_id=$1 AND o.accepted_at IS NOT NULL`,[data.ownerSchoolId]);
      if (!owner.rows.length) fail('The overall owner school must have an activated administrator account.');
      const existing = await client.query('SELECT id FROM school_branch_groups WHERE owner_school_id=$1',[data.ownerSchoolId]);
      const groupId = existing.rows[0]?.id;
      const conflicts = await client.query('SELECT school_id,group_id FROM school_branch_members WHERE school_id=ANY($1::uuid[])',[ids]);
      if (conflicts.rows.some(row => row.group_id !== groupId)) fail('A selected school already belongs to another branch group.');
      const group = await client.query(`INSERT INTO school_branch_groups(name,owner_school_id) VALUES($1,$2)
        ON CONFLICT(owner_school_id) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[name,data.ownerSchoolId]);
      for (const id of ids) await client.query(`INSERT INTO school_branch_members(school_id,group_id) VALUES($1,$2)
        ON CONFLICT(school_id) DO NOTHING`,[id,group.rows[0].id]);
      return { message:'Branches linked. The activated administrator of the overall owner school can compare all linked branches.' };
    });
  }
  const memberships = await query(`SELECT u.school_id FROM school_users u JOIN schools s ON s.id=u.school_id
    WHERE u.auth_user_id=$1 AND u.role='administrator' AND s.status='active'`,[user.id]);
  const adminIds = memberships.rows.map(row => row.school_id);
  const groups = await query(`SELECT g.*,o.auth_user_id AS owner_user_id FROM school_branch_groups g
    JOIN schools owner_school ON owner_school.id=g.owner_school_id AND owner_school.status='active'
    JOIN school_onboarding o ON o.school_id=g.owner_school_id
    WHERE $2::boolean OR (o.auth_user_id=$1 AND EXISTS(SELECT 1 FROM school_users u
      WHERE u.school_id=g.owner_school_id AND u.auth_user_id=$1 AND u.role='administrator'))
      OR EXISTS(SELECT 1 FROM school_branch_members m WHERE m.group_id=g.id AND m.school_id=ANY($3::uuid[]))`,[user.id,platform,adminIds]);
  const allowed = groups.rows;
  const ownerGroups = allowed.filter(g => platform || (g.owner_user_id === user.id && adminIds.includes(g.owner_school_id))).map(g => g.id);
  const groupIds = allowed.map(g => g.id);
  const branches = await query(`SELECT m.group_id,s.id,s.name FROM school_branch_members m JOIN schools s ON s.id=m.school_id
    WHERE m.group_id=ANY($1::uuid[]) AND s.status='active'
      AND (m.group_id=ANY($2::uuid[]) OR s.id=ANY($3::uuid[])) ORDER BY s.name`,[groupIds,ownerGroups,adminIds]);
  if (req.method === 'POST') {
    const data = await readBody(req);
    const branch = branches.rows.find(b => b.id === data.schoolId && b.group_id === data.groupId);
    if (!branch) fail('Branch access denied.',403);
    if (data.action === 'note') {
      const note = String(data.note || '').trim();
      if (note.length > 2000) fail('Keep the explanation within 2,000 characters.');
      const result = await query(`UPDATE school_branch_comparisons SET note=$4,note_updated_at=now()
        WHERE id=$1 AND group_id=$2 AND school_id=$3 RETURNING id`,[data.id,branch.group_id,branch.id,note]);
      if (!result.rows.length) fail('Comparison not found.',404);
      return {message:'Branch explanation saved.'};
    }
    if (!ownerGroups.includes(branch.group_id)) fail('Only the overall owner can match assessments.',403);
    const assessment = await query(`SELECT id FROM assessments WHERE id=$1 AND school_id=$2 AND published_at IS NOT NULL`,[data.assessmentId,branch.id]);
    if (!assessment.rows.length) fail('Choose a published assessment from this branch.');
    await query(`INSERT INTO school_branch_comparisons(group_id,school_id,assessment_id,course,level,component,basis)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(group_id,school_id,assessment_id)
      DO UPDATE SET course=EXCLUDED.course,level=EXCLUDED.level,component=EXCLUDED.component,basis=EXCLUDED.basis`,
      [branch.group_id,branch.id,data.assessmentId,label(data.course),label(data.level),label(data.component),label(data.basis)]);
    return {message:'Assessment matched for comparison.'};
  }
  if (req.method !== 'GET') fail('Method not allowed',405);
  const schoolIds = branches.rows.map(b => b.id);
  const assessments = await query(`SELECT a.id,a.school_id,c.name AS class_name,COALESCE(s.name,'General') AS subject,
      a.academic_year,a.term,a.published_at FROM assessments a
      JOIN classes c ON c.id=a.class_id AND c.school_id=a.school_id
      LEFT JOIN subjects s ON s.id=a.subject_id AND s.school_id=a.school_id
      WHERE a.school_id=ANY($1::uuid[]) AND a.published_at IS NOT NULL
      ORDER BY a.published_at DESC`,[schoolIds]);
  const matches = await query(`SELECT m.*,a.class_id,a.academic_year,a.term,a.maximum_score,a.grade_scale,a.pass_mark_snapshot,
    a.published_at,c.name AS class_name FROM school_branch_comparisons m
    JOIN assessments a ON a.id=m.assessment_id AND a.school_id=m.school_id
    JOIN classes c ON c.id=a.class_id AND c.school_id=a.school_id
    WHERE m.school_id=ANY($1::uuid[]) AND m.group_id=ANY($2::uuid[])`,[schoolIds,groupIds]);
  const rows = [];
  // Bounded database concurrency: one branch assessment at a time.
  for (const match of matches.rows) {
    const params = [match.school_id,match.class_id,match.academic_year,match.term,match.assessment_id];
    const summary = await query(`WITH cohort AS (
      SELECT id,status FROM students WHERE school_id=$1 AND class_id=$2
    ), marks AS (SELECT score FROM assessment_marks WHERE assessment_id=$5),
    attendance_counts AS (
      SELECT COUNT(*) AS recorded,COUNT(*) FILTER(WHERE status IN ('present','late')) AS attended,
        COUNT(*) FILTER(WHERE status='absent') AS absent
      FROM attendance WHERE school_id=$1 AND student_id IN (SELECT id FROM cohort)
        AND academic_year=$3 AND term=$4
    ), balances AS (
      SELECT st.id,
        COALESCE((SELECT SUM(GREATEST(0,fc.amount_bututs-COALESCE((SELECT SUM(fa.amount_bututs)
          FROM fee_adjustments fa WHERE fa.charge_id=fc.id AND fa.school_id=$1),0)))
          FROM fee_charges fc WHERE fc.school_id=$1 AND fc.student_id=st.id AND fc.academic_year=$3 AND fc.term=$4),0) AS charged,
        COALESCE((SELECT SUM(GREATEST(0,p.amount_bututs-COALESCE((SELECT SUM(pa.amount_bututs)
          FROM payment_adjustments pa WHERE pa.payment_id=p.id AND pa.school_id=$1),0)))
          FROM payments p WHERE p.school_id=$1 AND p.student_id=st.id AND p.academic_year=$3 AND p.term=$4),0) AS paid
      FROM cohort st
    ) SELECT (SELECT COUNT(*) FROM cohort WHERE status='active')::int AS students,
      (SELECT COUNT(*) FROM cohort WHERE status='active' AND id NOT IN
        (SELECT student_id FROM assessment_marks WHERE assessment_id=$5))::int AS missing,
      (SELECT json_agg(score) FROM marks) AS scores,
      (SELECT recorded FROM attendance_counts) AS recorded,(SELECT attended FROM attendance_counts) AS attended,
      (SELECT absent FROM attendance_counts) AS absent,
      (SELECT COUNT(*) FROM (SELECT student_id FROM attendance WHERE school_id=$1
        AND student_id IN (SELECT id FROM cohort) AND academic_year=$3 AND term=$4 AND status='absent'
        GROUP BY student_id HAVING COUNT(*)>=3) repeated)::int AS repeated_absences,
      COALESCE(SUM(charged),0) AS charged,COALESCE(SUM(paid),0) AS paid,
      COALESCE(SUM(GREATEST(0,charged-paid)),0) AS outstanding FROM balances`,params);
    const metrics = summary.rows[0];
    const exams = summarizeExams((metrics.scores || []).map(score => ({...match,score})));
    rows.push({...match,...metrics,scores:undefined,grade_scale:undefined,
      assessed:exams.subjects[0]?.marks || 0,average:exams.subjects[0]?.average ?? null,
      passRate:exams.passRate,collectionRate:collectionRate(metrics),
      attendanceRate:Number(metrics.recorded) ? 100*Number(metrics.attended)/Number(metrics.recorded) : null,
      comparisonKey:comparisonKey(match)});
  }
  return {groups:allowed.map(g => ({id:g.id,name:g.name,canCompare:ownerGroups.includes(g.id)})),branches:branches.rows,assessments:assessments.rows,rows};
}
