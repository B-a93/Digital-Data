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
test('academic periods close safely and preserve historical school records',async()=>{
 const [server,schema,app]=await Promise.all([
  readFile('apps/school-web/server.mjs','utf8'),
  readFile('apps/school-web/database/schema.sql','utf8'),
  readFile('apps/school-web/public/app.js','utf8'),
 ]);
 assert.match(schema,/CREATE TABLE IF NOT EXISTS academic_periods/);
 assert.match(schema,/academic_periods_one_active_idx/);
 assert.match(schema,/ALTER TABLE attendance ADD COLUMN IF NOT EXISTS academic_year/);
 assert.match(schema,/ALTER TABLE fee_charges ADD COLUMN IF NOT EXISTS academic_year/);
 assert.match(schema,/ALTER TABLE payments ADD COLUMN IF NOT EXISTS academic_year/);
 assert.match(schema,/ALTER TABLE assessments ADD COLUMN IF NOT EXISTS academic_year/);
 assert.match(server,/pathname === "\/api\/school\/academic-periods"/);
 assert.match(server,/confirmation !== context\.name/);
 assert.match(server,/academic_period\.closed/);
 assert.match(server,/current_academic_year=\$2,current_term=\$3/);
 assert.match(app,/Close current period and start next/);
 assert.match(app,/Previous records were preserved/);
});
test('finance corrections preserve original transactions and support fee due dates',async()=>{
 const [server,schema,app]=await Promise.all([
  readFile('apps/school-web/server.mjs','utf8'),
  readFile('apps/school-web/database/schema.sql','utf8'),
  readFile('apps/school-web/public/app.js','utf8'),
 ]);
 assert.match(schema,/CREATE TABLE IF NOT EXISTS payment_adjustments/);
 assert.match(schema,/adjustment_type IN \('refund','void'\)/);
 assert.match(schema,/CREATE TABLE IF NOT EXISTS fee_adjustments/);
 assert.match(schema,/adjustment_type IN \('waiver','discount'\)/);
 assert.match(schema,/fee_charges ADD COLUMN IF NOT EXISTS due_date date/);
 assert.match(server,/const paymentAdjustmentRoute/);
 assert.match(server,/const feeAdjustmentRoute/);
 assert.match(server,/cannot exceed the unadjusted payment amount/);
 assert.match(server,/cannot exceed the remaining charge/);
 assert.match(app,/Payment corrections and refunds/);
 assert.match(app,/Fee waivers and discounts/);
 assert.match(app,/Due date \(optional\)/);
 assert.match(app,/Original receipts remain in the audit trail/);
});
test('student lifecycle events preserve transfer, withdrawal and re-enrolment history',async()=>{
 const [server,schema,app]=await Promise.all([
  readFile('apps/school-web/server.mjs','utf8'),
  readFile('apps/school-web/database/schema.sql','utf8'),
  readFile('apps/school-web/public/app.js','utf8'),
 ]);
 assert.match(schema,/CREATE TABLE IF NOT EXISTS student_lifecycle_events/);
 assert.match(schema,/transferred_out/);
 assert.match(schema,/re_enrolled/);
 assert.match(schema,/students_status_check/);
 assert.match(server,/const lifecycleRoute/);
 assert.match(server,/student\.lifecycle_changed/);
 assert.match(server,/Only active students can be transferred/);
 assert.match(server,/Class promotion/);
 assert.match(server,/studentLifecycle: studentLifecycle\.rows/);
 assert.match(app,/Student lifecycle history/);
 assert.match(app,/Transfer to another school/);
 assert.match(app,/receiving school/);
 assert.match(app,/Edit \/ lifecycle/);
});
test('student register identifies incomplete and possible duplicate records safely',async()=>{
 const app=await readFile('apps/school-web/public/app.js','utf8');
 assert.match(app,/function studentDataQuality\(\)/);
 assert.match(app,/Student record quality/);
 assert.match(app,/guardian phone/);
 assert.match(app,/Possible duplicate groups/);
 assert.match(app,/No student is deleted or merged automatically/);
 assert.match(app,/Download review list/);
 assert.match(app,/student-data-quality-/);
 assert.match(app,/Complete record/);
});
test('guardian follow-ups record contact outcomes and due actions without automated messaging',async()=>{
 const [server,schema,app]=await Promise.all([
  readFile('apps/school-web/server.mjs','utf8'),
  readFile('apps/school-web/database/schema.sql','utf8'),
  readFile('apps/school-web/public/app.js','utf8'),
 ]);
 assert.match(schema,/CREATE TABLE IF NOT EXISTS guardian_follow_ups/);
 assert.match(schema,/contact_method IN \('phone','whatsapp','meeting','email','other'\)/);
 assert.match(server,/pathname === "\/api\/school\/guardian-follow-ups"/);
 assert.match(server,/guardian_follow_up\.created/);
 assert.match(server,/guardian_follow_up\.completed/);
 assert.match(server,/guardianFollowUps: guardianFollowUps\.rows/);
 assert.match(app,/Record guardian contact/);
 assert.match(app,/Next follow-up date/);
 assert.match(app,/Mark completed/);
 assert.match(app,/portal does not send them automatically/);
});
test('dashboard action centre prioritises operational work by staff role',async()=>{
 const [app,style]=await Promise.all([
  readFile('apps/school-web/public/app.js','utf8'),
  readFile('apps/school-web/public/style.css','utf8'),
 ]);
 assert.match(app,/function operationsActionCentre\(\)/);
 assert.match(app,/Operations action centre/);
 assert.match(app,/Guardian follow-ups due/);
 assert.match(app,/Attendance incomplete/);
 assert.match(app,/Admissions awaiting review/);
 assert.match(app,/Overdue student balances/);
 assert.match(app,/role === "Administrator" \|\| role === "Finance"/);
 assert.match(style,/\.action-centre/);
 assert.match(style,/\.action-item\.urgent/);
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
 assert.match(server,/trial_ends_at=CASE WHEN \$2 THEN now\(\) \+ interval '2 months'/);
 assert.match(schema,/trial_ends_at timestamptz/);
});
test('student admissions remain pending until a school administrator approves them',async()=>{
 const [server,schema,admissions,product]=await Promise.all([
  readFile('apps/school-web/server.mjs','utf8'),
  readFile('apps/school-web/database/schema.sql','utf8'),
  readFile('apps/school-web/public/admissions.html','utf8'),
  readFile('apps/school-web/public/product.html','utf8'),
 ]);
 assert.match(schema,/CREATE TABLE IF NOT EXISTS student_admission_applications/);
 assert.match(server,/pathname === "\/api\/admissions"/);
 assert.match(server,/status='pending' FOR UPDATE/);
 assert.match(server,/student_admission_applications/);
 assert.match(admissions,/Student registration application/);
 assert.match(product,/D750/);
 assert.match(product,/D1,500/);
 assert.match(product,/D2,000/);
 assert.match(product,/D3,000/);
 assert.match(product,/Custom/);
});
test('platform owner can delete only an unused pending school registration',async()=>{
 const [server,app]=await Promise.all([
  readFile('apps/school-web/server.mjs','utf8'),
  readFile('apps/school-web/public/app.js','utf8'),
 ]);
 assert.match(server,/school\?\.status === "pending" && !school\.accepted_at && !school\.has_users/);
 assert.match(app,/Delete pending workspace/);
 assert.match(app,/Pending workspace and invitation deleted/);
});
test('student import has a mobile-friendly file picker and empty-file validation',async()=>{
 const [app,style]=await Promise.all([
  readFile('apps/school-web/public/app.js','utf8'),
  readFile('apps/school-web/public/style.css','utf8'),
 ]);
 assert.match(app,/Select CSV from phone/);
 assert.match(app,/Choose a completed CSV file first/);
 assert.match(app,/selectedFile\?\.name/);
 assert.match(app,/importInput\.showPicker/);
 assert.match(app,/removeAttribute\("accept"\)/);
 assert.match(style,/\.mobile-file-native/);
 assert.match(style,/\.import-steps/);
 assert.match(app,/Import selected students/);
});
test('portal has mobile navigation and role-based dashboard shortcuts',async()=>{
 const [html,app,style]=await Promise.all([
  readFile('apps/school-web/public/index.html','utf8'),
  readFile('apps/school-web/public/app.js','utf8'),
  readFile('apps/school-web/public/style.css','utf8'),
 ]);
 assert.match(html,/id="mobile-menu"/);
 assert.match(html,/id="menu-overlay"/);
 assert.match(app,/function setMobileMenu/);
 assert.match(app,/What would you like to do\?/);
 assert.match(app,/Message parents/);
 assert.match(style,/body\.menu-open \.sidebar/);
 assert.match(style,/\.shortcut-grid/);
});
test('all password fields receive accessible show and hide controls',async()=>{
 const [app,style]=await Promise.all([
  readFile('apps/school-web/public/app.js','utf8'),
  readFile('apps/school-web/public/style.css','utf8'),
 ]);
 assert.match(app,/function initialisePasswordToggles/);
 assert.match(app,/button\.textContent = visible \? "Show" : "Hide"/);
 assert.match(app,/aria-pressed/);
 assert.match(style,/\.password-control/);
 assert.match(style,/\.password-toggle/);
 assert.match(app,/button\[type="submit"\], button:not\(\[type\]\)/);
});
test('administrator dashboard includes a guided school setup checklist',async()=>{
 const [app,style]=await Promise.all([
  readFile('apps/school-web/public/app.js','utf8'),
  readFile('apps/school-web/public/style.css','utf8'),
 ]);
 assert.match(app,/function schoolSetupChecklist/);
 assert.match(app,/steps completed/);
 assert.match(app,/Add classes/);
 assert.match(app,/Configure fee types/);
 assert.match(app,/Invite staff/);
 assert.match(app,/role="progressbar"/);
 assert.match(style,/\.setup-checklist/);
 assert.match(style,/\.setup-steps/);
});
test('platform owner has subscription billing records and access controls',async()=>{
 const [server,schema,app]=await Promise.all([
  readFile('apps/school-web/server.mjs','utf8'),
  readFile('apps/school-web/database/schema.sql','utf8'),
  readFile('apps/school-web/public/app.js','utf8'),
 ]);
 assert.match(schema,/CREATE TABLE IF NOT EXISTS platform_subscription_payments/);
 assert.match(schema,/subscription_paid_until date/);
 assert.match(server,/pathname === "\/api\/platform\/billing"/);
 assert.match(server,/pathname === "\/api\/platform\/billing\/payments"/);
 assert.match(server,/requirePlatformOwner\(req\)/);
 assert.match(app,/Billing & subscriptions/);
 assert.match(app,/Payment overdue/);
 assert.match(app,/Record a school payment/);
 assert.match(app,/billing-access/);
 assert.match(app,/count <= 150/);
 assert.match(app,/count <= 300/);
 assert.match(app,/count <= 600/);
 assert.match(app,/count <= 1000/);
 assert.match(app,/Large school/);
 assert.match(app,/Custom price/);
});
test('public SEO targets product pages while private workflows stay out of search',async()=>{
 const [login,product,onboarding,admissions,sitemap,llms]=await Promise.all([
  readFile('apps/school-web/public/index.html','utf8'),
  readFile('apps/school-web/public/product.html','utf8'),
  readFile('apps/school-web/public/onboarding.html','utf8'),
  readFile('apps/school-web/public/admissions.html','utf8'),
  readFile('apps/school-web/public/sitemap.xml','utf8'),
  readFile('apps/school-web/public/llms.txt','utf8'),
 ]);
 assert.match(login,/name="robots" content="noindex, follow"/);
 assert.match(admissions,/name="robots" content="noindex, follow"/);
 assert.match(product,/"@type": "WebApplication"/);
 assert.match(product,/"@type": "FAQPage"/);
 assert.match(product,/"priceCurrency": "GMD"/);
 assert.match(product,/hreflang="en-GM"/);
 assert.match(onboarding,/property="og:title"/);
 assert.doesNotMatch(sitemap,/elegantempireai\.com\/<\/loc>/);
 assert.doesNotMatch(sitemap,/\/admissions/);
 assert.match(llms,/Up to 150 students: D750/);
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
