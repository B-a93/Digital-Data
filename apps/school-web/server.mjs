import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  databaseHealth,
  initializeDatabase,
  query,
  transaction,
} from "./database.mjs";
import {
  requirePlatformOwner,
  verifyAuthenticatedUser,
} from "./auth-server.mjs";
import {
  sendOnboardingRequest,
  sendSchoolInvitation,
  sendStaffInvitation,
} from "./mailer.mjs";
const root = path.resolve(fileURLToPath(new URL("./public/", import.meta.url)));
const neonAuthUrl =
  "https://ep-spring-poetry-b2x3am6k.neonauth.c-6.eu-central-1.aws.neon.tech/neondb/auth";
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};
const json = (res, status, data) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
};
const onboardingAttempts = new Map();
async function readJsonBody(req) {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 200000)
      throw Object.assign(new Error("Request too large"), { status: 413 });
  }
  return JSON.parse(value || "{}");
}
async function proxyAuth(req, res, pathname, search) {
  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "cookie",
    "authorization",
    "user-agent",
  ]) {
    if (req.headers[name]) headers.set(name, req.headers[name]);
  }
  headers.set("origin", baseUrl() || `https://${req.headers.host}`);
  const chunks = [];
  let size = 0;
  if (req.method !== "GET" && req.method !== "HEAD") {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_000_000)
        throw Object.assign(new Error("Request too large"), { status: 413 });
      chunks.push(chunk);
    }
  }
  const suffix = pathname.slice("/api/auth".length);
  const upstream = await fetch(neonAuthUrl + suffix + search, {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    redirect: "manual",
  });
  const responseHeaders = {
    "Content-Type":
      upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const cookies = upstream.headers.getSetCookie?.() || [];
  if (cookies.length)
    responseHeaders["Set-Cookie"] = cookies.map((originalCookie) => {
      let cookie = originalCookie
        .replace(/;\s*Domain=[^;]+/gi, "")
        .replace(/;\s*Path=[^;]+/gi, "; Path=/api/auth");
      if (!/;\s*Path=/i.test(cookie)) cookie += "; Path=/api/auth";
      return cookie;
    });
  const location = upstream.headers.get("location");
  if (location) responseHeaders.Location = location;
  res.writeHead(upstream.status, responseHeaders);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const validAcademicYear = (value) => {
  const match = /^(\d{4})\/(\d{2})$/.exec(value);
  return Boolean(
    match && Number(match[2]) === (Number(match[1]) + 1) % 100,
  );
};
const baseUrl = () =>
  String(process.env.APP_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
function invitation() {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    hash: tokenHash(token),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
}
const schoolTypeCode = (label) =>
  ({
    "Public school": "public",
    "Private school": "private",
    "Mission school": "mission",
    "Community school": "community",
    "Vocational school": "vocational",
    "Skills-training centre": "training_centre",
    "College or specialised institute": "college",
  })[label];
function selfServiceSlug(name) {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "school";
  return `${base}-${randomBytes(3).toString("hex")}`;
}
async function emailInvitation(record, invite) {
  if (!baseUrl()) throw new Error("APP_BASE_URL is not configured");
  await sendSchoolInvitation({
    to: record.administrator_email,
    name: record.administrator_name,
    school: record.name,
    link: `${baseUrl()}/?invite=${encodeURIComponent(invite.token)}`,
    expiresAt: invite.expiresAt,
  });
}
async function emailStaffInvitation(record, invite) {
  if (!baseUrl()) throw new Error("APP_BASE_URL is not configured");
  await sendStaffInvitation({
    to: record.email,
    name: record.full_name,
    school: record.school_name,
    role: record.role,
    link: `${baseUrl()}/?invite=${encodeURIComponent(invite.token)}`,
    expiresAt: invite.expiresAt,
  });
}
async function requireSchoolContext(req) {
  const user = await verifyAuthenticatedUser(req);
  const result = await query(
    `SELECT su.school_id,su.role,s.name FROM school_users su
     JOIN schools s ON s.id=su.school_id
     WHERE su.auth_user_id=$1 AND s.status='active'
     ORDER BY su.created_at LIMIT 1`,
    [user.id],
  );
  if (!result.rows[0])
    throw Object.assign(
      new Error("This account is not connected to an active school."),
      { status: 403 },
    );
  return { ...user, ...result.rows[0] };
}
function requireRole(context, ...allowed) {
  if (context.role === "owner" || allowed.includes(context.role)) return;
  throw Object.assign(
    new Error("Your school role does not allow this action."),
    { status: 403 },
  );
}
async function recordAudit(
  context,
  action,
  entityType,
  entityId = null,
  details = {},
) {
  try {
    await query(
      `INSERT INTO audit_logs(school_id,actor_user_id,actor_email,action,entity_type,entity_id,details)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        context.school_id,
        context.id,
        context.email,
        action,
        entityType,
        entityId,
        JSON.stringify(details),
      ],
    );
  } catch (error) {
    console.error("[audit] write failed:", error.message);
  }
}
const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, "http://localhost");
    const pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
      await proxyAuth(req, res, pathname, requestUrl.search);
      return;
    }
    if (pathname === "/api/health") {
      const database = await databaseHealth();
      const body = JSON.stringify({
        status: database.ok ? "ok" : "degraded",
        database,
      });
      res.writeHead(database.ok ? 200 : 503, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
      return;
    }
    if (pathname === "/api/onboarding-requests") {
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const ip = String(
          req.headers["x-forwarded-for"] || req.socket.remoteAddress,
        )
          .split(",")[0]
          .trim(),
        now = Date.now(),
        recent = (onboardingAttempts.get(ip) || []).filter(
          (time) => now - time < 60 * 60 * 1000,
        );
      if (recent.length >= 5) {
        json(res, 429, {
          error: "Too many requests. Please try again later.",
        });
        return;
      }
      const data = await readJsonBody(req);
      if (String(data.website || "").trim()) {
        json(res, 200, { status: "received" });
        return;
      }
      const request = {
        onboardingMode: String(data.onboardingMode || "assisted").trim(),
        organisationName: String(data.organisationName || "").trim(),
        organisationType: String(data.organisationType || "").trim(),
        region: String(data.region || "").trim(),
        contactName: String(data.contactName || "").trim(),
        email: String(data.email || "")
          .trim()
          .toLowerCase(),
        phone: String(data.phone || "").trim(),
        studentCount: String(data.studentCount || "").trim(),
        preferredContact: String(data.preferredContact || "Email").trim(),
        trialRequested: Boolean(data.trialRequested),
        importHelp: String(data.importHelp || "").trim(),
        dataFormat: String(data.dataFormat || "").trim(),
        academicYears: String(data.academicYears || "").trim(),
        importScope: Array.isArray(data.importScope)
          ? [...new Set(data.importScope.map((value) => String(value).trim()))]
          : [],
        retentionAcknowledged: data.retentionAcknowledged === true,
        message: String(data.message || "").trim(),
      };
      if (
        !request.organisationName ||
        !request.contactName ||
        !["self_service", "assisted"].includes(request.onboardingMode) ||
        !/^\S+@\S+\.\S+$/.test(request.email) ||
        ![
          "Public school",
          "Private school",
          "Mission school",
          "Community school",
          "Vocational school",
          "Skills-training centre",
          "College or specialised institute",
        ].includes(request.organisationType) ||
        !["Email", "Phone", "WhatsApp"].includes(request.preferredContact) ||
        ![
          "No existing data to import",
          "Self-service import",
          "Assisted import",
        ].includes(request.importHelp) ||
        ![
          "None",
          "Excel or CSV",
          "PDF",
          "Paper records",
          "Another school system",
          "Mixed formats",
        ].includes(request.dataFormat) ||
        request.importScope.some(
          (value) =>
            !["Student profiles", "Fees and payments", "Attendance", "Results"].includes(value),
        ) ||
        !request.retentionAcknowledged ||
        Object.values(request).some(
          (value) => typeof value === "string" && value.length > 1200,
        )
      ) {
        json(res, 400, { error: "Enter valid onboarding details." });
        return;
      }
      if (request.onboardingMode === "self_service") {
        const invite = invitation(),
          count = Number(request.studentCount || 0),
          slug = selfServiceSlug(request.organisationName);
        const record = await transaction(async (client) => {
          const school = (
            await client.query(
              `INSERT INTO schools(name,slug,school_type,region,contact_name,contact_email,contact_phone,
                                   status,onboarding_mode,trial_requested,estimated_student_count)
               VALUES($1,$2,$3,$4,$5,$6,$7,'pending','self_service',$8,$9)
               RETURNING id,name`,
              [
                request.organisationName,
                slug,
                schoolTypeCode(request.organisationType),
                request.region || null,
                request.contactName,
                request.email,
                request.phone || null,
                request.trialRequested,
                Number.isInteger(count) && count > 0 ? count : null,
              ],
            )
          ).rows[0];
          await client.query(
            `INSERT INTO school_onboarding(school_id,administrator_name,administrator_email,
                                           invitation_status,invitation_token_hash,invitation_expires_at,invited_at)
             VALUES($1,$2,$3,'sent',$4,$5,now())`,
            [school.id, request.contactName, request.email, invite.hash, invite.expiresAt],
          );
          return {
            ...school,
            administrator_name: request.contactName,
            administrator_email: request.email,
          };
        });
        let invitationSent = true;
        try {
          await emailInvitation(record, invite);
        } catch (error) {
          invitationSent = false;
          console.error("[email] self-onboarding invitation failed:", error.message);
          await query(
            `UPDATE school_onboarding SET invitation_status='email_failed' WHERE school_id=$1`,
            [record.id],
          );
        }
        try {
          await sendOnboardingRequest(request);
        } catch (error) {
          console.error("[email] self-onboarding notice failed:", error.message);
        }
        onboardingAttempts.set(ip, [...recent, now]);
        json(res, 201, {
          status: invitationSent ? "invitation_sent" : "email_failed",
          message: invitationSent
            ? "Your school workspace has been created. Check your email for the secure activation link."
            : "Your workspace request was saved, but the activation email could not be delivered. Elegant Empire AI will contact you.",
        });
        return;
      }
      await sendOnboardingRequest(request);
      onboardingAttempts.set(ip, [...recent, now]);
      json(res, 201, {
        status: "received",
        message:
          "Your assisted onboarding request has been received. Elegant Empire AI will contact you after reviewing the details.",
      });
      return;
    }
    if (pathname === "/api/admissions") {
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        schoolCode = String(data.schoolCode || "").trim().toLowerCase(),
        fullName = String(data.fullName || "").trim(),
        guardianName = String(data.guardianName || "").trim(),
        guardianPhone = String(data.guardianPhone || "").trim(),
        guardianEmail = String(data.guardianEmail || "").trim().toLowerCase(),
        dateOfBirth = String(data.dateOfBirth || "").trim(),
        gender = String(data.gender || "").trim(),
        address = String(data.address || "").trim(),
        previousSchool = String(data.previousSchool || "").trim(),
        preferredClass = String(data.preferredClass || "").trim(),
        notes = String(data.notes || "").trim();
      if (
        !/^[a-z0-9-]{3,60}$/.test(schoolCode) ||
        !fullName || fullName.length > 120 ||
        !guardianName || guardianName.length > 120 ||
        !guardianPhone || guardianPhone.length > 40 ||
        (guardianEmail && !/^\S+@\S+\.\S+$/.test(guardianEmail)) ||
        (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) ||
        [gender,address,previousSchool,preferredClass].some((value) => value.length > 200) ||
        notes.length > 1000
      ) {
        json(res, 400, { error: "Enter valid student and guardian details." });
        return;
      }
      const school = (
        await query(`SELECT id,name FROM schools WHERE slug=$1 AND status='active'`, [schoolCode])
      ).rows[0];
      if (!school) {
        json(res, 404, { error: "School code not found. Ask the school to confirm its code." });
        return;
      }
      const application = (
        await query(
          `INSERT INTO student_admission_applications(
             school_id,full_name,date_of_birth,gender,address,guardian_name,guardian_phone,
             guardian_email,previous_school,preferred_class,notes)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id,status,created_at`,
          [school.id,fullName,dateOfBirth || null,gender || null,address || null,guardianName,
           guardianPhone,guardianEmail || null,previousSchool || null,preferredClass || null,notes || null],
        )
      ).rows[0];
      json(res, 201, {
        application,
        schoolName: school.name,
        message: "Application submitted. The school will review it before creating a student record.",
      });
      return;
    }
    if (pathname === "/api/me") {
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const user = await verifyAuthenticatedUser(req);
      const ownerEmail = String(process.env.PLATFORM_OWNER_EMAIL || "")
        .trim()
        .toLowerCase();
      if (ownerEmail && user.email === ownerEmail) {
        json(res, 200, {
          user: { id: user.id, email: user.email, role: "platform_owner" },
          school: null,
        });
        return;
      }
      const membership = await query(
        `SELECT su.role,s.id,s.name,s.slug,s.current_academic_year,s.current_term,s.pass_mark,s.grade_scale,s.school_type,s.status,
                s.trial_status,s.trial_started_at,s.trial_ends_at
         FROM school_users su JOIN schools s ON s.id=su.school_id
         WHERE su.auth_user_id=$1 AND s.status='active'
         ORDER BY su.created_at LIMIT 1`,
        [user.id],
      );
      if (!membership.rows[0]) {
        json(res, 403, {
          error: "This account is not connected to an active school.",
        });
        return;
      }
      const row = membership.rows[0];
      json(res, 200, {
        user: { id: user.id, email: user.email, role: row.role },
        school: {
          id: row.id,
          name: row.name,
          slug: row.slug,
          academicYear: row.current_academic_year,
          term: row.current_term,
          passMark: Number(row.pass_mark),
          gradeScale: row.grade_scale,
          schoolType: row.school_type,
          status: row.status,
          trialStatus: row.trial_status,
          trialStartedAt: row.trial_started_at,
          trialEndsAt: row.trial_ends_at,
        },
      });
      return;
    }
    if (pathname === "/api/school/activity") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const result = await query(
        `SELECT id,actor_email,action,entity_type,entity_id,details,created_at
         FROM audit_logs WHERE school_id=$1 ORDER BY created_at DESC LIMIT 200`,
        [context.school_id],
      );
      json(res, 200, { activity: result.rows });
      return;
    }
    if (pathname === "/api/school/backup") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const [
        school,
        classes,
        subjects,
        programmes,
        students,
        attendance,
        feeTypes,
        charges,
        payments,
        assessments,
        marks,
        timetable,
        staff,
        activity,
        academicPeriods,
        paymentAdjustments,
        feeAdjustments,
        studentLifecycle,
      ] = await Promise.all([
        query(
          `SELECT id,name,slug,current_academic_year,current_term,pass_mark,grade_scale,school_type,region,district,
             contact_name,contact_email,contact_phone,status,created_at,updated_at
           FROM schools WHERE id=$1`,
          [context.school_id],
        ),
        query(
          `SELECT id,name,created_at FROM classes WHERE school_id=$1 ORDER BY name`,
          [context.school_id],
        ),
        query(
          `SELECT id,name,created_at FROM subjects WHERE school_id=$1 ORDER BY name`,
          [context.school_id],
        ),
        query(
          `SELECT id,name,duration_months,qualification,status,created_at FROM programmes WHERE school_id=$1 ORDER BY name`,
          [context.school_id],
        ),
        query(
          `SELECT id,class_id,student_number,full_name,guardian_name,guardian_phone,status,created_at,updated_at
           FROM students WHERE school_id=$1 ORDER BY full_name`,
          [context.school_id],
        ),
        query(
          `SELECT id,student_id,attendance_date,status,academic_year,term,recorded_at
           FROM attendance WHERE school_id=$1 ORDER BY attendance_date,student_id`,
          [context.school_id],
        ),
        query(
          `SELECT id,name,created_at FROM fee_types WHERE school_id=$1 ORDER BY name`,
          [context.school_id],
        ),
        query(
          `SELECT id,student_id,fee_type_id,description,amount_bututs,academic_year,term,due_date,created_at
           FROM fee_charges WHERE school_id=$1 ORDER BY created_at`,
          [context.school_id],
        ),
        query(
          `SELECT id,student_id,amount_bututs,receipt_number,academic_year,term,paid_on,created_at
           FROM payments WHERE school_id=$1 ORDER BY paid_on,created_at`,
          [context.school_id],
        ),
        query(
          `SELECT id,class_id,subject_id,title,academic_year,term,maximum_score,published_at,created_at
           FROM assessments WHERE school_id=$1 ORDER BY created_at`,
          [context.school_id],
        ),
        query(
          `SELECT am.assessment_id,am.student_id,am.score,am.remark,am.updated_at
           FROM assessment_marks am JOIN assessments a ON a.id=am.assessment_id
           WHERE a.school_id=$1 ORDER BY am.assessment_id,am.student_id`,
          [context.school_id],
        ),
        query(
          `SELECT id,class_id,subject_id,weekday,start_time,end_time,teacher_name,academic_year,term,created_at
           FROM timetable_entries WHERE school_id=$1 ORDER BY class_id,weekday,start_time`,
          [context.school_id],
        ),
        query(
          `SELECT full_name,email,role,invitation_status,invited_at,accepted_at
           FROM staff_invitations WHERE school_id=$1 ORDER BY full_name`,
          [context.school_id],
        ),
        query(
          `SELECT actor_email,action,entity_type,entity_id,details,created_at
           FROM audit_logs WHERE school_id=$1 ORDER BY created_at`,
          [context.school_id],
        ),
        query(
          `SELECT id,academic_year,term,status,opened_at,closed_at,closed_by,created_at
           FROM academic_periods WHERE school_id=$1 ORDER BY opened_at`,
          [context.school_id],
        ),
        query(
          `SELECT id,payment_id,adjustment_type,amount_bututs,reason,recorded_by,created_at
           FROM payment_adjustments WHERE school_id=$1 ORDER BY created_at`,
          [context.school_id],
        ),
        query(
          `SELECT id,charge_id,adjustment_type,amount_bututs,reason,recorded_by,created_at
           FROM fee_adjustments WHERE school_id=$1 ORDER BY created_at`,
          [context.school_id],
        ),
        query(
          `SELECT id,student_id,event_type,previous_status,new_status,previous_class_id,new_class_id,
                  event_date,reason,related_school,notes,recorded_by,created_at
           FROM student_lifecycle_events WHERE school_id=$1 ORDER BY event_date,created_at`,
          [context.school_id],
        ),
      ]);
      const backup = {
        format: "digital-data-school-backup",
        version: 1,
        generatedAt: new Date().toISOString(),
        school: school.rows[0],
        classes: classes.rows,
        subjects: subjects.rows,
        programmes: programmes.rows,
        students: students.rows,
        attendance: attendance.rows,
        feeTypes: feeTypes.rows,
        charges: charges.rows,
        payments: payments.rows,
        assessments: assessments.rows,
        assessmentMarks: marks.rows,
        timetable: timetable.rows,
        staff: staff.rows,
        activity: activity.rows,
        academicPeriods: academicPeriods.rows,
        paymentAdjustments: paymentAdjustments.rows,
        feeAdjustments: feeAdjustments.rows,
        studentLifecycle: studentLifecycle.rows,
      };
      await recordAudit(
        context,
        "backup.downloaded",
        "school",
        context.school_id,
        {
          students: students.rowCount,
          assessments: assessments.rowCount,
        },
      );
      json(res, 200, { backup });
      return;
    }
    if (pathname === "/api/school/students") {
      const context = await requireSchoolContext(req);
      if (req.method === "GET") {
        const [students, schoolClasses, subjects] = await Promise.all([
          query(
            `SELECT st.id,st.student_number,st.full_name,st.guardian_name,st.guardian_phone,
                    st.date_of_birth,st.gender,st.address,st.previous_school,st.admission_date,
                    st.status,c.name AS class_name
             FROM students st LEFT JOIN classes c ON c.id=st.class_id
             WHERE st.school_id=$1 ORDER BY st.full_name`,
            [context.school_id],
          ),
          query(
            `SELECT id,name FROM classes WHERE school_id=$1 ORDER BY name`,
            [context.school_id],
          ),
          query(
            `SELECT id,name FROM subjects WHERE school_id=$1 ORDER BY name`,
            [context.school_id],
          ),
        ]);
        json(res, 200, {
          students: students.rows,
          classes: schoolClasses.rows,
          subjects: subjects.rows,
        });
        return;
      }
      if (req.method === "POST") {
        requireRole(context, "administrator");
        const data = await readJsonBody(req),
          studentNumber = String(data.studentNumber || "")
            .trim()
            .toUpperCase(),
          fullName = String(data.fullName || "").trim(),
          className = String(data.className || "").trim(),
          guardianName = String(data.guardianName || "").trim(),
          guardianPhone = String(data.guardianPhone || "").trim(),
          dateOfBirth = String(data.dateOfBirth || "").trim(),
          gender = String(data.gender || "").trim(),
          address = String(data.address || "").trim(),
          previousSchool = String(data.previousSchool || "").trim(),
          admissionDate = String(data.admissionDate || "").trim();
        if (
          !/^[A-Z0-9][A-Z0-9\-/]{1,29}$/.test(studentNumber) ||
          !fullName ||
          !className ||
          guardianName.length > 100 ||
          guardianPhone.length > 40 ||
          (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) ||
          (admissionDate && !/^\d{4}-\d{2}-\d{2}$/.test(admissionDate)) ||
          gender.length > 40 || address.length > 300 || previousSchool.length > 160
        ) {
          json(res, 400, { error: "Enter valid student details." });
          return;
        }
        const student = await transaction(async (client) => {
          const schoolClass = (
            await client.query(
              `INSERT INTO classes(school_id,name) VALUES($1,$2)
               ON CONFLICT(school_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name`,
              [context.school_id, className],
            )
          ).rows[0];
          const created = (
            await client.query(
              `INSERT INTO students(school_id,class_id,student_number,full_name,guardian_name,guardian_phone,
                                    date_of_birth,gender,address,previous_school,admission_date)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               RETURNING id,student_number,full_name,guardian_name,guardian_phone,date_of_birth,gender,address,
                         previous_school,admission_date,status`,
              [
                context.school_id,
                schoolClass.id,
                studentNumber,
                fullName,
                guardianName || null,
                guardianPhone || null,
                dateOfBirth || null,
                gender || null,
                address || null,
                previousSchool || null,
                admissionDate || null,
              ],
            )
          ).rows[0];
          await client.query(
            `INSERT INTO student_lifecycle_events(school_id,student_id,event_type,new_status,new_class_id,event_date,reason,recorded_by)
             VALUES($1,$2,'admitted','active',$3,COALESCE($4::date,CURRENT_DATE),'Student registered',$5)`,
            [context.school_id,created.id,schoolClass.id,admissionDate || null,context.auth_user_id],
          );
          return created;
        });
        await recordAudit(context, "student.created", "student", student.id, {
          studentNumber,
          fullName,
          className,
          guardianName,
          guardianPhone,
          dateOfBirth,
          gender,
          address,
          previousSchool,
          admissionDate,
        });
        json(res, 201, { student });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    if (pathname === "/api/school/admissions") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const applications = await query(
        `SELECT id,full_name,date_of_birth,gender,address,guardian_name,guardian_phone,
                guardian_email,previous_school,preferred_class,notes,status,created_at,reviewed_at
         FROM student_admission_applications WHERE school_id=$1
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC`,
        [context.school_id],
      );
      json(res, 200, { applications: applications.rows });
      return;
    }
    const admissionRoute = pathname.match(
      /^\/api\/school\/admissions\/([0-9a-f-]{36})$/,
    );
    if (admissionRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "PATCH") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req), action = String(data.action || "").trim();
      if (!['approve','reject'].includes(action)) {
        json(res, 400, { error: "Choose approve or reject." });
        return;
      }
      const result = await transaction(async (client) => {
        const application = (
          await client.query(
            `SELECT * FROM student_admission_applications
             WHERE id=$1 AND school_id=$2 AND status='pending' FOR UPDATE`,
            [admissionRoute[1], context.school_id],
          )
        ).rows[0];
        if (!application) return null;
        let student = null;
        if (action === 'approve') {
          const studentNumber = String(data.studentNumber || '').trim().toUpperCase(),
            className = String(data.className || '').trim();
          if (!/^[A-Z0-9][A-Z0-9\-/]{1,29}$/.test(studentNumber) || !className)
            throw Object.assign(Error('Assign a valid student number and class.'), { status: 400 });
          const schoolClass = (
            await client.query(
              `INSERT INTO classes(school_id,name) VALUES($1,$2)
               ON CONFLICT(school_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
              [context.school_id,className],
            )
          ).rows[0];
          student = (
            await client.query(
              `INSERT INTO students(school_id,class_id,student_number,full_name,guardian_name,guardian_phone,
                                    date_of_birth,gender,address,previous_school,admission_date)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_DATE)
               RETURNING id,student_number,full_name`,
              [context.school_id,schoolClass.id,studentNumber,application.full_name,application.guardian_name,
               application.guardian_phone,application.date_of_birth,application.gender,application.address,
               application.previous_school],
            )
          ).rows[0];
          await client.query(
            `INSERT INTO student_lifecycle_events(school_id,student_id,event_type,new_status,new_class_id,event_date,reason,recorded_by)
             VALUES($1,$2,'admitted','active',$3,CURRENT_DATE,'Admission application approved',$4)`,
            [context.school_id,student.id,schoolClass.id,context.auth_user_id],
          );
        }
        await client.query(
          `UPDATE student_admission_applications
           SET status=$3,reviewed_by=$4,reviewed_at=now(),updated_at=now()
           WHERE id=$1 AND school_id=$2`,
          [admissionRoute[1],context.school_id,action === 'approve' ? 'approved' : 'rejected',context.auth_user_id],
        );
        return { application, student };
      });
      if (!result) {
        json(res, 404, { error: "Pending application not found." });
        return;
      }
      await recordAudit(context, action === 'approve' ? 'admission.approved' : 'admission.rejected', "admission_application", admissionRoute[1], {
        studentId: result.student?.id || null,
      });
      json(res, 200, { status: action === 'approve' ? 'approved' : 'rejected', student: result.student });
      return;
    }
    if (pathname === "/api/school/students/promote") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        fromClass = String(data.fromClass || "").trim(),
        toClass = String(data.toClass || "").trim(),
        studentIds = Array.isArray(data.studentIds)
          ? [...new Set(data.studentIds.map(String))]
          : [];
      if (
        !fromClass ||
        !toClass ||
        fromClass === toClass ||
        !studentIds.length ||
        studentIds.length > 1000 ||
        studentIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))
      ) {
        json(res, 400, {
          error: "Choose students and two different valid classes.",
        });
        return;
      }
      const promoted = await transaction(async (client) => {
        const classes = (
          await client.query(
            `SELECT id,name FROM classes WHERE school_id=$1 AND name=ANY($2::text[])`,
            [context.school_id, [fromClass, toClass]],
          )
        ).rows;
        const source = classes.find((item) => item.name === fromClass),
          destination = classes.find((item) => item.name === toClass);
        if (!source || !destination)
          throw Object.assign(new Error("One of the classes was not found."), {
            status: 404,
          });
        const eligible = (
          await client.query(
            `SELECT id,class_id,status FROM students
             WHERE school_id=$1 AND class_id=$2 AND status='active' AND id=ANY($3::uuid[]) FOR UPDATE`,
            [context.school_id, source.id, studentIds],
          )
        ).rows;
        if (!eligible.length) return 0;
        await client.query(
            `UPDATE students SET class_id=$4,updated_at=now()
             WHERE school_id=$1 AND class_id=$2 AND status='active' AND id=ANY($3::uuid[])
             RETURNING id`,
            [context.school_id, source.id, studentIds, destination.id],
        );
        for (const student of eligible)
          await client.query(
            `INSERT INTO student_lifecycle_events(school_id,student_id,event_type,previous_status,new_status,previous_class_id,new_class_id,event_date,reason,recorded_by)
             VALUES($1,$2,'promoted','active','active',$3,$4,CURRENT_DATE,'Class promotion',$5)`,
            [context.school_id,student.id,source.id,destination.id,context.auth_user_id],
          );
        return eligible.length;
      });
      if (!promoted) {
        json(res, 409, {
          error: "No eligible active students were found in the source class.",
        });
        return;
      }
      await recordAudit(context, "students.promoted", "student", null, {
        fromClass,
        toClass,
        count: promoted,
      });
      json(res, 200, { promoted });
      return;
    }
    if (pathname === "/api/school/staff") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method === "GET") {
        const result = await query(
          `SELECT id,full_name,email,role,invitation_status,invited_at,accepted_at
           FROM staff_invitations WHERE school_id=$1 ORDER BY full_name`,
          [context.school_id],
        );
        json(res, 200, { staff: result.rows });
        return;
      }
      if (req.method === "POST") {
        const data = await readJsonBody(req),
          fullName = String(data.fullName || "").trim(),
          email = String(data.email || "")
            .trim()
            .toLowerCase(),
          staffRole = String(data.role || "")
            .trim()
            .toLowerCase();
        if (
          !fullName ||
          fullName.length > 100 ||
          !/^\S+@\S+\.\S+$/.test(email) ||
          !["teacher", "finance"].includes(staffRole)
        ) {
          json(res, 400, { error: "Enter valid staff details." });
          return;
        }
        const invite = invitation();
        const record = (
          await query(
            `INSERT INTO staff_invitations(school_id,full_name,email,role,invitation_status,invitation_token_hash,invitation_expires_at,invited_at)
             VALUES($1,$2,$3,$4,'sent',$5,$6,now())
             ON CONFLICT(school_id,email) DO UPDATE SET full_name=EXCLUDED.full_name,role=EXCLUDED.role,
             invitation_status='sent',invitation_token_hash=EXCLUDED.invitation_token_hash,
             invitation_expires_at=EXCLUDED.invitation_expires_at,invited_at=now()
             WHERE staff_invitations.accepted_at IS NULL
             RETURNING *, $7::text AS school_name`,
            [
              context.school_id,
              fullName,
              email,
              staffRole,
              invite.hash,
              invite.expiresAt,
              context.name,
            ],
          )
        ).rows[0];
        if (!record) {
          json(res, 409, { error: "This staff account is already active." });
          return;
        }
        try {
          await emailStaffInvitation(record, invite);
          json(res, 201, { status: "sent" });
        } catch (error) {
          console.error("[email] staff invitation failed:", error.message);
          await query(
            `UPDATE staff_invitations SET invitation_status='email_failed' WHERE id=$1`,
            [record.id],
          );
          json(res, 502, {
            error: "The staff invitation email could not be sent.",
          });
        }
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const staffResendRoute = pathname.match(
      /^\/api\/school\/staff\/([0-9a-f-]{36})\/resend$/,
    );
    if (staffResendRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const invite = invitation();
      const record = (
        await query(
          `UPDATE staff_invitations SET invitation_status='sent',invitation_token_hash=$3,
           invitation_expires_at=$4,invited_at=now() WHERE id=$1 AND school_id=$2
           AND accepted_at IS NULL RETURNING *, $5::text AS school_name`,
          [
            staffResendRoute[1],
            context.school_id,
            invite.hash,
            invite.expiresAt,
            context.name,
          ],
        )
      ).rows[0];
      if (!record) {
        json(res, 404, { error: "Pending staff invitation not found." });
        return;
      }
      try {
        await emailStaffInvitation(record, invite);
        json(res, 200, { status: "sent" });
      } catch (error) {
        console.error("[email] staff resend failed:", error.message);
        await query(
          `UPDATE staff_invitations SET invitation_status='email_failed' WHERE id=$1`,
          [record.id],
        );
        json(res, 502, {
          error: "The staff invitation email could not be sent.",
        });
      }
      return;
    }
    const staffRoute = pathname.match(
      /^\/api\/school\/staff\/([0-9a-f-]{36})$/,
    );
    if (staffRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method === "PATCH") {
        const staffRole = String(
          (await readJsonBody(req)).role || "",
        ).toLowerCase();
        if (!["teacher", "finance"].includes(staffRole)) {
          json(res, 400, { error: "Choose Teacher or Finance." });
          return;
        }
        const member = await transaction(async (client) => {
          const updated = (
            await client.query(
              `UPDATE staff_invitations SET role=$3 WHERE id=$1 AND school_id=$2
               RETURNING id,auth_user_id,role`,
              [staffRoute[1], context.school_id, staffRole],
            )
          ).rows[0];
          if (updated?.auth_user_id)
            await client.query(
              `UPDATE school_users SET role=$3 WHERE school_id=$1 AND auth_user_id=$2`,
              [context.school_id, updated.auth_user_id, staffRole],
            );
          return updated;
        });
        if (!member) {
          json(res, 404, { error: "Staff member not found." });
          return;
        }
        json(res, 200, { staff: member });
        return;
      }
      if (req.method === "DELETE") {
        const member = await transaction(async (client) => {
          const found = (
            await client.query(
              `SELECT id,auth_user_id FROM staff_invitations WHERE id=$1 AND school_id=$2 FOR UPDATE`,
              [staffRoute[1], context.school_id],
            )
          ).rows[0];
          if (!found) return null;
          if (found.auth_user_id)
            await client.query(
              `DELETE FROM school_users WHERE school_id=$1 AND auth_user_id=$2`,
              [context.school_id, found.auth_user_id],
            );
          await client.query(
            `UPDATE staff_invitations SET invitation_status='revoked',invitation_token_hash=NULL,
             invitation_expires_at=NULL,accepted_at=NULL,auth_user_id=NULL WHERE id=$1`,
            [found.id],
          );
          return found;
        });
        if (!member) {
          json(res, 404, { error: "Staff member not found." });
          return;
        }
        json(res, 200, { status: "revoked" });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    if (pathname === "/api/school/students/import") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        rows = Array.isArray(data.students) ? data.students : [];
      if (!rows.length || rows.length > 1000) {
        json(res, 400, {
          error: "Import between 1 and 1,000 students at a time.",
        });
        return;
      }
      const prepared = rows.map((row, index) => ({
        row: index + 2,
        studentNumber: String(row.studentNumber || "")
          .trim()
          .toUpperCase(),
        fullName: String(row.fullName || "").trim(),
        className: String(row.className || "").trim(),
        guardianName: String(row.guardianName || "").trim(),
        guardianPhone: String(row.guardianPhone || "").trim(),
      }));
      const invalid = prepared.filter(
        (row) =>
          !/^[A-Z0-9][A-Z0-9\-/]{1,29}$/.test(row.studentNumber) ||
          !row.fullName ||
          row.fullName.length > 100 ||
          !row.className ||
          row.className.length > 60 ||
          row.guardianName.length > 100 ||
          row.guardianPhone.length > 40,
      );
      const seen = new Set(),
        duplicateRows = prepared.filter((row) => {
          if (seen.has(row.studentNumber)) return true;
          seen.add(row.studentNumber);
          return false;
        });
      if (invalid.length || duplicateRows.length) {
        const badRows = [
          ...new Set([...invalid, ...duplicateRows].map((row) => row.row)),
        ];
        json(res, 400, {
          error: `Correct CSV row${badRows.length === 1 ? "" : "s"} ${badRows.join(", ")} and try again.`,
        });
        return;
      }
      const existing = await query(
        `SELECT student_number FROM students WHERE school_id=$1 AND student_number=ANY($2::text[])`,
        [context.school_id, prepared.map((row) => row.studentNumber)],
      );
      if (existing.rows.length) {
        json(res, 409, {
          error: `Already registered: ${existing.rows.map((row) => row.student_number).join(", ")}. Remove them from the CSV and try again.`,
        });
        return;
      }
      await transaction(async (client) => {
        const classIds = new Map();
        for (const row of prepared) {
          if (!classIds.has(row.className)) {
            const schoolClass = (
              await client.query(
                `INSERT INTO classes(school_id,name) VALUES($1,$2)
                 ON CONFLICT(school_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
                [context.school_id, row.className],
              )
            ).rows[0];
            classIds.set(row.className, schoolClass.id);
          }
          const created = (await client.query(
            `INSERT INTO students(school_id,class_id,student_number,full_name,guardian_name,guardian_phone)
             VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              context.school_id,
              classIds.get(row.className),
              row.studentNumber,
              row.fullName,
              row.guardianName || null,
              row.guardianPhone || null,
            ],
          )).rows[0];
          await client.query(
            `INSERT INTO student_lifecycle_events(school_id,student_id,event_type,new_status,new_class_id,event_date,reason,recorded_by)
             VALUES($1,$2,'admitted','active',$3,CURRENT_DATE,'Student imported',$4)`,
            [context.school_id,created.id,classIds.get(row.className),context.auth_user_id],
          );
        }
      });
      await recordAudit(context, "students.imported", "student", null, {
        count: prepared.length,
      });
      json(res, 201, { imported: prepared.length });
      return;
    }
    if (pathname === "/api/school/subjects") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const name = String((await readJsonBody(req)).name || "").trim();
      if (!name || name.length > 80) {
        json(res, 400, { error: "Enter a valid subject name." });
        return;
      }
      const subject = (
        await query(
          `INSERT INTO subjects(school_id,name) VALUES($1,$2) RETURNING id,name`,
          [context.school_id, name],
        )
      ).rows[0];
      await recordAudit(context, "subject.created", "subject", subject.id, {
        name,
      });
      json(res, 201, { subject });
      return;
    }
    const subjectRoute = pathname.match(
      /^\/api\/school\/subjects\/([0-9a-f-]{36})$/,
    );
    if (subjectRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "DELETE") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const subject = (
        await query(
          `DELETE FROM subjects WHERE id=$1 AND school_id=$2 RETURNING id,name`,
          [subjectRoute[1], context.school_id],
        )
      ).rows[0];
      if (!subject) {
        json(res, 404, { error: "Subject not found." });
        return;
      }
      await recordAudit(context, "subject.removed", "subject", subject.id, {
        name: subject.name,
      });
      json(res, 200, { status: "deleted" });
      return;
    }
    if (pathname === "/api/school/programmes") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method === "GET") {
        const result = await query(
          `SELECT id,name,duration_months,qualification,status
           FROM programmes WHERE school_id=$1 ORDER BY name`,
          [context.school_id],
        );
        json(res, 200, { programmes: result.rows });
        return;
      }
      if (req.method === "POST") {
        const data = await readJsonBody(req),
          name = String(data.name || "").trim(),
          qualification = String(data.qualification || "").trim(),
          durationMonths = Number(data.durationMonths);
        if (
          !name ||
          name.length > 100 ||
          !qualification ||
          qualification.length > 100 ||
          !Number.isInteger(durationMonths) ||
          durationMonths < 1 ||
          durationMonths > 120
        ) {
          json(res, 400, { error: "Enter valid programme details." });
          return;
        }
        const programme = (
          await query(
            `INSERT INTO programmes(school_id,name,duration_months,qualification)
             VALUES($1,$2,$3,$4) RETURNING id,name,duration_months,qualification,status`,
            [context.school_id, name, durationMonths, qualification],
          )
        ).rows[0];
        await recordAudit(
          context,
          "programme.created",
          "programme",
          programme.id,
          { name, durationMonths, qualification },
        );
        json(res, 201, { programme });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const programmeRoute = pathname.match(
      /^\/api\/school\/programmes\/([0-9a-f-]{36})$/,
    );
    if (programmeRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "DELETE") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const programme = (
        await query(
          `DELETE FROM programmes WHERE id=$1 AND school_id=$2 RETURNING id,name`,
          [programmeRoute[1], context.school_id],
        )
      ).rows[0];
      if (!programme) {
        json(res, 404, { error: "Programme not found." });
        return;
      }
      await recordAudit(
        context,
        "programme.removed",
        "programme",
        programme.id,
        { name: programme.name },
      );
      json(res, 200, { status: "deleted" });
      return;
    }
    if (pathname === "/api/school/academic-periods") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method === "GET") {
        const [school, periods] = await Promise.all([
          query(
            `SELECT current_academic_year,current_term FROM schools WHERE id=$1`,
            [context.school_id],
          ),
          query(
            `SELECT id,academic_year,term,status,opened_at,closed_at
             FROM academic_periods WHERE school_id=$1
             ORDER BY opened_at DESC,created_at DESC`,
            [context.school_id],
          ),
        ]);
        json(res, 200, { current: school.rows[0], periods: periods.rows });
        return;
      }
      if (req.method === "POST") {
        const data = await readJsonBody(req),
          academicYear = String(data.academicYear || "").trim(),
          term = String(data.term || "").trim(),
          confirmation = String(data.confirmation || "").trim();
        if (
          !validAcademicYear(academicYear) ||
          !term ||
          term.length > 60 ||
          confirmation !== context.name
        ) {
          json(res, 400, {
            error: "Enter the next academic year, term and school name exactly.",
          });
          return;
        }
        const period = await transaction(async (client) => {
          const school = (
            await client.query(
              `SELECT current_academic_year,current_term FROM schools WHERE id=$1 FOR UPDATE`,
              [context.school_id],
            )
          ).rows[0];
          if (
            school.current_academic_year === academicYear &&
            school.current_term === term
          )
            throw Object.assign(
              new Error("Choose a different academic year or term."),
              { status: 409 },
            );
          await client.query(
            `UPDATE academic_periods SET status='closed',closed_at=now(),closed_by=$2
             WHERE school_id=$1 AND status='active'`,
            [context.school_id, context.id],
          );
          const next = (
            await client.query(
              `INSERT INTO academic_periods(school_id,academic_year,term,status)
               VALUES($1,$2,$3,'active')
               ON CONFLICT(school_id,academic_year,term)
               DO UPDATE SET status='active',opened_at=now(),closed_at=NULL,closed_by=NULL
               RETURNING id,academic_year,term,status,opened_at,closed_at`,
              [context.school_id, academicYear, term],
            )
          ).rows[0];
          await client.query(
            `UPDATE schools SET current_academic_year=$2,current_term=$3,updated_at=now()
             WHERE id=$1`,
            [context.school_id, academicYear, term],
          );
          return { previous: school, current: next };
        });
        await recordAudit(
          context,
          "academic_period.closed",
          "academic_period",
          period.current.id,
          {
            previousAcademicYear: period.previous.current_academic_year,
            previousTerm: period.previous.current_term,
            academicYear,
            term,
          },
        );
        json(res, 201, period);
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    if (pathname === "/api/school/settings") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "PATCH") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        name = String(data.name || "").trim(),
        term = String(data.term || "").trim(),
        passMark = Number(data.passMark),
        gradeScale = {
          A: Number(data.gradeScale?.A),
          B: Number(data.gradeScale?.B),
          C: Number(data.gradeScale?.C),
        };
      if (
        !name ||
        name.length > 100 ||
        !term ||
        term.length > 60 ||
        !Number.isFinite(passMark) ||
        passMark < 0 ||
        passMark > 100 ||
        !Number.isFinite(gradeScale.A) ||
        !Number.isFinite(gradeScale.B) ||
        !Number.isFinite(gradeScale.C) ||
        gradeScale.A > 100 ||
        gradeScale.A <= gradeScale.B ||
        gradeScale.B <= gradeScale.C ||
        gradeScale.C < passMark
      ) {
        json(res, 400, { error: "Enter valid school settings." });
        return;
      }
      const settings = (
        await query(
          `UPDATE schools SET name=$2,pass_mark=$3,grade_scale=$4,updated_at=now()
           WHERE id=$1 RETURNING id,name,current_academic_year,current_term,pass_mark,grade_scale`,
          [context.school_id, name, passMark, gradeScale],
        )
      ).rows[0];
      await recordAudit(
        context,
        "settings.updated",
        "school",
        context.school_id,
        {
          name,
          term,
          passMark,
          gradeScale,
        },
      );
      json(res, 200, { settings });
      return;
    }
    if (pathname === "/api/school/cancellation") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        deletionChoice = String(data.deletionChoice || ""),
        reason = String(data.reason || "").trim(),
        confirmation = String(data.confirmation || "").trim();
      if (
        !["retain_three_months", "delete_immediately"].includes(deletionChoice) ||
        reason.length > 500 ||
        confirmation !== context.name
      ) {
        json(res, 400, {
          error: "Choose a data option and enter the school name exactly to confirm.",
        });
        return;
      }
      const immediate = deletionChoice === "delete_immediately";
      const school = (
        await query(
          `UPDATE schools
           SET status=$2,cancellation_requested_at=now(),
               retention_until=CASE WHEN $3 THEN NULL ELSE now() + interval '3 months' END,
               deletion_requested_at=CASE WHEN $3 THEN now() ELSE NULL END,
               cancellation_reason=$4,updated_at=now()
           WHERE id=$1 AND status='active'
           RETURNING id,name,status,cancellation_requested_at,retention_until,deletion_requested_at`,
          [
            context.school_id,
            immediate ? "pending_deletion" : "cancelled",
            immediate,
            reason || null,
          ],
        )
      ).rows[0];
      if (!school) {
        json(res, 409, { error: "This workspace is no longer active." });
        return;
      }
      await query(
        `INSERT INTO school_data_deletions(school_id,school_name,requested_by,requested_at,deletion_reason)
         VALUES($1,$2,$3,now(),$4)`,
        [
          context.school_id,
          context.name,
          context.email,
          immediate ? "immediate_request" : "retention_expiry",
        ],
      );
      await recordAudit(context, "school.cancellation_requested", "school", context.school_id, {
        deletionChoice,
        retentionUntil: school.retention_until,
        reason: reason || null,
      });
      json(res, 200, { school });
      return;
    }
    if (pathname === "/api/school/classes") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const name = String((await readJsonBody(req)).name || "").trim();
      if (!name || name.length > 60) {
        json(res, 400, { error: "Enter a valid class name." });
        return;
      }
      const schoolClass = (
        await query(
          `INSERT INTO classes(school_id,name) VALUES($1,$2)
           RETURNING id,name`,
          [context.school_id, name],
        )
      ).rows[0];
      json(res, 201, { class: schoolClass });
      return;
    }
    const classRoute = pathname.match(
      /^\/api\/school\/classes\/([0-9a-f-]{36})$/,
    );
    if (classRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "DELETE") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const result = await query(
        `DELETE FROM classes c WHERE c.id=$1 AND c.school_id=$2
         AND NOT EXISTS(SELECT 1 FROM students st WHERE st.class_id=c.id)
         RETURNING c.id`,
        [classRoute[1], context.school_id],
      );
      if (!result.rows[0]) {
        json(res, 409, {
          error: "Move all students before removing this class.",
        });
        return;
      }
      json(res, 200, { status: "deleted" });
      return;
    }
    if (pathname === "/api/school/fee-types") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const name = String((await readJsonBody(req)).name || "").trim();
      if (!name || name.length > 60) {
        json(res, 400, { error: "Enter a valid fee type." });
        return;
      }
      const feeType = (
        await query(
          `INSERT INTO fee_types(school_id,name) VALUES($1,$2)
           RETURNING id,name`,
          [context.school_id, name],
        )
      ).rows[0];
      json(res, 201, { feeType });
      return;
    }
    const feeTypeRoute = pathname.match(
      /^\/api\/school\/fee-types\/([0-9a-f-]{36})$/,
    );
    if (feeTypeRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "DELETE") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const result = await query(
        `DELETE FROM fee_types ft WHERE ft.id=$1 AND ft.school_id=$2
         AND NOT EXISTS(SELECT 1 FROM fee_charges fc WHERE fc.fee_type_id=ft.id)
         RETURNING ft.id`,
        [feeTypeRoute[1], context.school_id],
      );
      if (!result.rows[0]) {
        json(res, 409, { error: "This fee type is already used by a charge." });
        return;
      }
      json(res, 200, { status: "deleted" });
      return;
    }
    const studentProfileRoute = pathname.match(
      /^\/api\/school\/students\/([0-9a-f-]{36})\/profile$/,
    );
    if (studentProfileRoute) {
      const context = await requireSchoolContext(req);
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const student = (
        await query(
          `SELECT st.id,st.student_number,st.full_name,st.guardian_name,st.guardian_phone,
             st.status,st.created_at,c.name AS class_name,s.current_term,s.pass_mark
           FROM students st LEFT JOIN classes c ON c.id=st.class_id
           JOIN schools s ON s.id=st.school_id
           WHERE st.id=$1 AND st.school_id=$2`,
          [studentProfileRoute[1], context.school_id],
        )
      ).rows[0];
      if (!student) {
        json(res, 404, { error: "Student not found." });
        return;
      }
      const canAcademic = ["owner", "administrator", "teacher"].includes(
          context.role,
        ),
        canFinance = ["owner", "administrator", "finance"].includes(
          context.role,
        ),
        attendance = canAcademic
          ? (
              await query(
                `SELECT count(*)::int AS marked,
                   count(*) FILTER (WHERE status='present')::int AS present,
                   count(*) FILTER (WHERE status='late')::int AS late,
                   count(*) FILTER (WHERE status='absent')::int AS absent,
                   count(*) FILTER (WHERE status='excused')::int AS excused
                 FROM attendance WHERE school_id=$1 AND student_id=$2`,
                [context.school_id, student.id],
              )
            ).rows[0]
          : null,
        finance = canFinance
          ? (
              await query(
                `SELECT
                   COALESCE((SELECT sum(amount_bututs) FROM fee_charges WHERE school_id=$1 AND student_id=$2),0)::bigint AS charges,
                   COALESCE((SELECT sum(amount_bututs) FROM payments WHERE school_id=$1 AND student_id=$2),0)::bigint AS payments`,
                [context.school_id, student.id],
              )
            ).rows[0]
          : null,
        results = canAcademic
          ? (
              await query(
                `WITH latest AS (
                   SELECT DISTINCT ON (COALESCE(su.name,'General'))
                     a.id,COALESCE(su.name,'General') AS subject_name,a.maximum_score
                   FROM assessments a
                   JOIN assessment_marks own ON own.assessment_id=a.id AND own.student_id=$2
                   LEFT JOIN subjects su ON su.id=a.subject_id
                   WHERE a.school_id=$1 AND a.term=$3 AND a.published_at IS NOT NULL
                   ORDER BY COALESCE(su.name,'General'),a.published_at DESC
                 )
                 SELECT l.subject_name,am.score,l.maximum_score,COALESCE(am.remark,'') AS remark
                 FROM latest l JOIN assessment_marks am ON am.assessment_id=l.id
                 WHERE am.student_id=$2 ORDER BY l.subject_name`,
                [context.school_id, student.id, student.current_term],
              )
            ).rows
          : [];
      json(res, 200, {
        student,
        attendance,
        finance,
        results,
        permissions: { academic: canAcademic, finance: canFinance },
      });
      return;
    }
    const lifecycleRoute = pathname.match(
      /^\/api\/school\/students\/([0-9a-f-]{36})\/lifecycle$/,
    );
    if (lifecycleRoute) {
      const context = await requireSchoolContext(req);
      const studentId = lifecycleRoute[1];
      if (req.method === "GET") {
        const student = (await query(
          `SELECT id FROM students WHERE id=$1 AND school_id=$2`,
          [studentId,context.school_id],
        )).rows[0];
        if (!student) {
          json(res,404,{ error: "Student not found." });
          return;
        }
        const events = await query(
          `SELECT e.id,e.event_type,e.previous_status,e.new_status,e.event_date,e.reason,
                  e.related_school,e.notes,e.created_at,pc.name AS previous_class,nc.name AS new_class
           FROM student_lifecycle_events e
           LEFT JOIN classes pc ON pc.id=e.previous_class_id
           LEFT JOIN classes nc ON nc.id=e.new_class_id
           WHERE e.school_id=$1 AND e.student_id=$2
           ORDER BY e.event_date DESC,e.created_at DESC`,
          [context.school_id,studentId],
        );
        json(res,200,{ events: events.rows });
        return;
      }
      requireRole(context,"administrator");
      if (req.method !== "POST") {
        json(res,405,{ error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        action = String(data.action || "").trim(),
        eventDate = String(data.eventDate || "").trim(),
        reason = String(data.reason || "").trim(),
        relatedSchool = String(data.relatedSchool || "").trim(),
        className = String(data.className || "").trim();
      const actions = {
        transfer: ["transferred_out","transferred"],
        withdraw: ["withdrawn","withdrawn"],
        graduate: ["graduated","graduated"],
        deactivate: ["deactivated","inactive"],
        re_enrol: ["re_enrolled","active"],
        reactivate: ["reactivated","active"],
      };
      if (!actions[action] || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || reason.length < 3 || reason.length > 300 || relatedSchool.length > 160) {
        json(res,400,{ error: "Choose an action and date, then enter a reason (3–300 characters)." });
        return;
      }
      if (action === "transfer" && !relatedSchool) {
        json(res,400,{ error: "Enter the receiving school for a transfer." });
        return;
      }
      const result = await transaction(async (client) => {
        const student = (await client.query(
          `SELECT id,status,class_id FROM students WHERE id=$1 AND school_id=$2 FOR UPDATE`,
          [studentId,context.school_id],
        )).rows[0];
        if (!student) return null;
        const [eventType,newStatus] = actions[action];
        if (newStatus !== "active" && student.status !== "active")
          throw Object.assign(Error("Only active students can be transferred, withdrawn, graduated or deactivated."),{ status: 409 });
        if (newStatus === "active" && student.status === "active")
          throw Object.assign(Error("This student is already active."),{ status: 409 });
        let newClassId = student.class_id;
        if (newStatus === "active" && className)
          newClassId = (await client.query(
            `INSERT INTO classes(school_id,name) VALUES($1,$2)
             ON CONFLICT(school_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
            [context.school_id,className],
          )).rows[0].id;
        await client.query(
          `UPDATE students SET status=$3,class_id=$4,updated_at=now() WHERE id=$1 AND school_id=$2`,
          [studentId,context.school_id,newStatus,newClassId],
        );
        const event = (await client.query(
          `INSERT INTO student_lifecycle_events(school_id,student_id,event_type,previous_status,new_status,previous_class_id,new_class_id,event_date,reason,related_school,recorded_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id,event_type,event_date,new_status`,
          [context.school_id,studentId,eventType,student.status,newStatus,student.class_id,newClassId,eventDate,reason,relatedSchool || null,context.auth_user_id],
        )).rows[0];
        return event;
      });
      if (!result) {
        json(res,404,{ error: "Student not found." });
        return;
      }
      await recordAudit(context,"student.lifecycle_changed","student",studentId,{ action,eventDate,reason,relatedSchool: relatedSchool || null });
      json(res,201,{ event: result });
      return;
    }
    const studentRoute = pathname.match(
      /^\/api\/school\/students\/([0-9a-f-]{36})$/,
    );
    if (studentRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "PATCH") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req);
      const studentNumber = String(data.studentNumber || "")
          .trim()
          .toUpperCase(),
        fullName = String(data.fullName || "").trim(),
        className = String(data.className || "").trim(),
        guardianName = String(data.guardianName || "").trim(),
        guardianPhone = String(data.guardianPhone || "").trim(),
        dateOfBirth = String(data.dateOfBirth || "").trim(),
        gender = String(data.gender || "").trim(),
        address = String(data.address || "").trim(),
        previousSchool = String(data.previousSchool || "").trim(),
        admissionDate = String(data.admissionDate || "").trim();
      if (
        !/^[A-Z0-9][A-Z0-9\-/]{1,29}$/.test(studentNumber) ||
        !fullName ||
        !className ||
        guardianName.length > 100 ||
        guardianPhone.length > 40 ||
        (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) ||
        (admissionDate && !/^\d{4}-\d{2}-\d{2}$/.test(admissionDate)) ||
        gender.length > 40 || address.length > 300 || previousSchool.length > 160
      ) {
        json(res, 400, { error: "Enter valid student details." });
        return;
      }
      const updated = await transaction(async (client) => {
        const previous = (await client.query(
          `SELECT class_id,status FROM students WHERE id=$1 AND school_id=$2 FOR UPDATE`,
          [studentRoute[1],context.school_id],
        )).rows[0];
        if (!previous) return null;
        const schoolClass = (
          await client.query(
            `INSERT INTO classes(school_id,name) VALUES($1,$2)
             ON CONFLICT(school_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
            [context.school_id, className],
          )
        ).rows[0];
        const result = (
          await client.query(
            `UPDATE students SET student_number=$3,full_name=$4,class_id=$5,guardian_name=$6,guardian_phone=$7,
                                 date_of_birth=$8,gender=$9,address=$10,previous_school=$11,admission_date=$12,updated_at=now()
             WHERE id=$1 AND school_id=$2
             RETURNING id,student_number,full_name,guardian_name,guardian_phone,date_of_birth,gender,address,
                       previous_school,admission_date,status`,
            [
              studentRoute[1],
              context.school_id,
              studentNumber,
              fullName,
              schoolClass.id,
              guardianName || null,
              guardianPhone || null,
              dateOfBirth || null,
              gender || null,
              address || null,
              previousSchool || null,
              admissionDate || null,
            ],
          )
        ).rows[0];
        if (previous.class_id !== schoolClass.id)
          await client.query(
            `INSERT INTO student_lifecycle_events(school_id,student_id,event_type,previous_status,new_status,previous_class_id,new_class_id,event_date,reason,recorded_by)
             VALUES($1,$2,'class_changed',$3,$3,$4,$5,CURRENT_DATE,'Student details updated',$6)`,
            [context.school_id,studentRoute[1],previous.status,previous.class_id,schoolClass.id,context.auth_user_id],
          );
        return result;
      });
      if (!updated) {
        json(res, 404, { error: "Student not found." });
        return;
      }
      await recordAudit(context, "student.updated", "student", updated.id, {
        studentNumber,
        fullName,
        className,
        guardianName,
        guardianPhone,
        dateOfBirth,
        gender,
        address,
        previousSchool,
        admissionDate,
      });
      json(res, 200, { student: updated });
      return;
    }
    if (pathname === "/api/school/finance") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator", "finance");
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const [feeTypes, charges, payments, paymentAdjustments, feeAdjustments] = await Promise.all([
        query(
          `SELECT id,name FROM fee_types WHERE school_id=$1 ORDER BY name`,
          [context.school_id],
        ),
        query(
          `SELECT fc.id,fc.student_id,fc.description,fc.amount_bututs AS original_amount_bututs,
                  GREATEST(0,fc.amount_bututs-COALESCE(SUM(fa.amount_bututs),0)) AS amount_bututs,
                  fc.due_date,fc.academic_year,fc.term,fc.created_at
           FROM fee_charges fc LEFT JOIN fee_adjustments fa ON fa.charge_id=fc.id
           WHERE fc.school_id=$1 GROUP BY fc.id ORDER BY fc.created_at`,
          [context.school_id],
        ),
        query(
          `SELECT p.id,p.student_id,p.amount_bututs AS original_amount_bututs,
                  GREATEST(0,p.amount_bututs-COALESCE(SUM(pa.amount_bututs),0)) AS amount_bututs,
                  p.receipt_number,p.paid_on,p.academic_year,p.term,p.created_at,
                  CASE WHEN COALESCE(SUM(pa.amount_bututs),0)=0 THEN 'recorded'
                       WHEN COALESCE(SUM(pa.amount_bututs),0)>=p.amount_bututs AND BOOL_OR(pa.adjustment_type='void') THEN 'voided'
                       WHEN COALESCE(SUM(pa.amount_bututs),0)>=p.amount_bututs THEN 'refunded'
                       ELSE 'partially_refunded' END AS status
           FROM payments p LEFT JOIN payment_adjustments pa ON pa.payment_id=p.id
           WHERE p.school_id=$1 GROUP BY p.id ORDER BY p.created_at`,
          [context.school_id],
        ),
        query(
          `SELECT pa.id,pa.payment_id,pa.adjustment_type,pa.amount_bututs,pa.reason,pa.created_at
           FROM payment_adjustments pa WHERE pa.school_id=$1 ORDER BY pa.created_at DESC`,
          [context.school_id],
        ),
        query(
          `SELECT fa.id,fa.charge_id,fa.adjustment_type,fa.amount_bututs,fa.reason,fa.created_at
           FROM fee_adjustments fa WHERE fa.school_id=$1 ORDER BY fa.created_at DESC`,
          [context.school_id],
        ),
      ]);
      json(res, 200, {
        feeTypes: feeTypes.rows,
        charges: charges.rows,
        payments: payments.rows,
        paymentAdjustments: paymentAdjustments.rows,
        feeAdjustments: feeAdjustments.rows,
      });
      return;
    }
    if (pathname === "/api/school/charges") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator", "finance");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        studentId = String(data.studentId || ""),
        description = String(data.description || "").trim(),
        amount = Number(data.amountBututs),
        dueDate = String(data.dueDate || "").trim();
      if (
        !/^[0-9a-f-]{36}$/.test(studentId) ||
        !description ||
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
      ) {
        json(res, 400, { error: "Enter a valid charge." });
        return;
      }
      const charge = await transaction(async (client) => {
        const student = (
          await client.query(
            `SELECT id FROM students WHERE id=$1 AND school_id=$2`,
            [studentId, context.school_id],
          )
        ).rows[0];
        if (!student)
          throw Object.assign(new Error("Student not found."), { status: 404 });
        const feeType = (
          await client.query(
            `INSERT INTO fee_types(school_id,name) VALUES($1,$2)
             ON CONFLICT(school_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
            [context.school_id, description],
          )
        ).rows[0];
        return (
          await client.query(
            `INSERT INTO fee_charges(school_id,student_id,fee_type_id,description,amount_bututs,academic_year,term,due_date)
             SELECT $1,$2,$3,$4,$5,current_academic_year,current_term,$6::date FROM schools WHERE id=$1
             RETURNING id,student_id,description,amount_bututs,academic_year,term,due_date,created_at`,
            [context.school_id, studentId, feeType.id, description, amount, dueDate || null],
          )
        ).rows[0];
      });
      await recordAudit(context, "charge.created", "charge", charge.id, {
        studentId,
        description,
        amountBututs: amount,
        dueDate: dueDate || null,
      });
      json(res, 201, { charge });
      return;
    }
    if (pathname === "/api/school/class-charges") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator", "finance");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        className = String(data.className || "").trim(),
        description = String(data.description || "").trim(),
        amount = Number(data.amountBututs),
        dueDate = String(data.dueDate || "").trim();
      if (
        !className ||
        !description ||
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
      ) {
        json(res, 400, { error: "Choose a class, fee type and valid amount." });
        return;
      }
      const result = await transaction(async (client) => {
        const schoolClass = (
          await client.query(
            `SELECT id FROM classes WHERE school_id=$1 AND name=$2`,
            [context.school_id, className],
          )
        ).rows[0];
        if (!schoolClass)
          throw Object.assign(new Error("Class not found."), { status: 404 });
        const students = (
          await client.query(
            `SELECT id FROM students WHERE school_id=$1 AND class_id=$2 AND status='active'`,
            [context.school_id, schoolClass.id],
          )
        ).rows;
        if (!students.length)
          throw Object.assign(
            new Error("This class has no active students to charge."),
            { status: 409 },
          );
        const feeType = (
          await client.query(
            `INSERT INTO fee_types(school_id,name) VALUES($1,$2)
             ON CONFLICT(school_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
            [context.school_id, description],
          )
        ).rows[0];
        for (const student of students)
          await client.query(
            `INSERT INTO fee_charges(school_id,student_id,fee_type_id,description,amount_bututs,academic_year,term,due_date)
             SELECT $1,$2,$3,$4,$5,current_academic_year,current_term,$6::date FROM schools WHERE id=$1`,
            [context.school_id, student.id, feeType.id, description, amount, dueDate || null],
          );
        return students.length;
      });
      await recordAudit(context, "class_charge.created", "charge", null, {
        className,
        description,
        amountBututs: amount,
        dueDate: dueDate || null,
        students: result,
      });
      json(res, 201, { charged: result });
      return;
    }
    if (pathname === "/api/school/payments") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator", "finance");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        studentId = String(data.studentId || ""),
        operationKey = String(data.operationKey || ""),
        amount = Number(data.amountBututs);
      if (
        !/^[0-9a-f-]{36}$/.test(studentId) ||
        !/^[0-9a-f-]{36}$/.test(operationKey) ||
        !Number.isSafeInteger(amount) ||
        amount <= 0
      ) {
        json(res, 400, { error: "Enter a valid payment." });
        return;
      }
      const student = (
        await query(`SELECT id FROM students WHERE id=$1 AND school_id=$2`, [
          studentId,
          context.school_id,
        ])
      ).rows[0];
      if (!student) {
        json(res, 404, { error: "Student not found." });
        return;
      }
      const receiptNumber = `REC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
      const payment = (
        await query(
          `INSERT INTO payments(school_id,student_id,amount_bututs,receipt_number,operation_key,paid_on,recorded_by,academic_year,term)
           SELECT $1,$2,$3,$4,$5,CURRENT_DATE,$6,current_academic_year,current_term FROM schools WHERE id=$1
           ON CONFLICT(school_id,operation_key) DO UPDATE SET operation_key=EXCLUDED.operation_key
           RETURNING id,student_id,amount_bututs,receipt_number,paid_on,created_at`,
          [
            context.school_id,
            studentId,
            amount,
            receiptNumber,
            operationKey,
            context.id,
          ],
        )
      ).rows[0];
      await recordAudit(context, "payment.recorded", "payment", payment.id, {
        studentId,
        amountBututs: amount,
        receiptNumber: payment.receipt_number,
      });
      json(res, 201, { payment });
      return;
    }
    const paymentAdjustmentRoute = pathname.match(
      /^\/api\/school\/payments\/([0-9a-f-]{36})\/adjustments$/,
    );
    if (paymentAdjustmentRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator", "finance");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        adjustmentType = String(data.adjustmentType || ""),
        requestedAmount = Number(data.amountBututs),
        reason = String(data.reason || "").trim();
      if (
        !["refund", "void"].includes(adjustmentType) ||
        reason.length < 3 ||
        reason.length > 300 ||
        (adjustmentType === "refund" &&
          (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0))
      ) {
        json(res, 400, { error: "Choose a valid correction and enter a reason." });
        return;
      }
      const adjustment = await transaction(async (client) => {
        const payment = (
          await client.query(
            `SELECT p.id,p.amount_bututs,p.receipt_number,
                    COALESCE((SELECT SUM(amount_bututs) FROM payment_adjustments WHERE payment_id=p.id),0)::bigint AS adjusted_bututs
             FROM payments p WHERE p.id=$1 AND p.school_id=$2 FOR UPDATE`,
            [paymentAdjustmentRoute[1], context.school_id],
          )
        ).rows[0];
        if (!payment)
          throw Object.assign(new Error("Payment not found."), { status: 404 });
        const remaining = Number(payment.amount_bututs) - Number(payment.adjusted_bututs),
          amount = adjustmentType === "void" ? remaining : requestedAmount;
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining)
          throw Object.assign(
            new Error("The correction cannot exceed the unadjusted payment amount."),
            { status: 409 },
          );
        const row = (
          await client.query(
            `INSERT INTO payment_adjustments(school_id,payment_id,adjustment_type,amount_bututs,reason,recorded_by)
             VALUES($1,$2,$3,$4,$5,$6)
             RETURNING id,payment_id,adjustment_type,amount_bututs,reason,created_at`,
            [context.school_id, payment.id, adjustmentType, amount, reason, context.id],
          )
        ).rows[0];
        return { ...row, receiptNumber: payment.receipt_number };
      });
      await recordAudit(
        context,
        `payment.${adjustmentType === "void" ? "voided" : "refunded"}`,
        "payment",
        paymentAdjustmentRoute[1],
        {
          receiptNumber: adjustment.receiptNumber,
          amountBututs: Number(adjustment.amount_bututs),
          reason,
        },
      );
      json(res, 201, { adjustment });
      return;
    }
    const feeAdjustmentRoute = pathname.match(
      /^\/api\/school\/charges\/([0-9a-f-]{36})\/adjustments$/,
    );
    if (feeAdjustmentRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator", "finance");
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        adjustmentType = String(data.adjustmentType || ""),
        amount = Number(data.amountBututs),
        reason = String(data.reason || "").trim();
      if (
        !["waiver", "discount"].includes(adjustmentType) ||
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        reason.length < 3 ||
        reason.length > 300
      ) {
        json(res, 400, { error: "Enter a valid waiver or discount and reason." });
        return;
      }
      const adjustment = await transaction(async (client) => {
        const charge = (
          await client.query(
            `SELECT fc.id,fc.amount_bututs,fc.description,
                    COALESCE((SELECT SUM(amount_bututs) FROM fee_adjustments WHERE charge_id=fc.id),0)::bigint AS adjusted_bututs
             FROM fee_charges fc WHERE fc.id=$1 AND fc.school_id=$2 FOR UPDATE`,
            [feeAdjustmentRoute[1], context.school_id],
          )
        ).rows[0];
        if (!charge)
          throw Object.assign(new Error("Charge not found."), { status: 404 });
        const remaining = Number(charge.amount_bututs) - Number(charge.adjusted_bututs);
        if (amount > remaining)
          throw Object.assign(
            new Error("The waiver or discount cannot exceed the remaining charge."),
            { status: 409 },
          );
        const row = (
          await client.query(
            `INSERT INTO fee_adjustments(school_id,charge_id,adjustment_type,amount_bututs,reason,recorded_by)
             VALUES($1,$2,$3,$4,$5,$6)
             RETURNING id,charge_id,adjustment_type,amount_bututs,reason,created_at`,
            [context.school_id, charge.id, adjustmentType, amount, reason, context.id],
          )
        ).rows[0];
        return { ...row, description: charge.description };
      });
      await recordAudit(context, `charge.${adjustmentType}`, "charge", feeAdjustmentRoute[1], {
        description: adjustment.description,
        amountBututs: Number(adjustment.amount_bututs),
        reason,
      });
      json(res, 201, { adjustment });
      return;
    }
    if (pathname === "/api/school/attendance") {
      const context = await requireSchoolContext(req),
        attendanceDate = String(
          req.method === "GET" ? requestUrl.searchParams.get("date") || "" : "",
        ),
        className = String(
          req.method === "GET"
            ? requestUrl.searchParams.get("class") || ""
            : "",
        ).trim();
      requireRole(context, "administrator", "teacher");
      if (req.method === "GET") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(attendanceDate) || !className) {
          json(res, 400, { error: "Choose a valid class and date." });
          return;
        }
        const result = await query(
          `SELECT st.id AS student_id,a.status,a.recorded_at
           FROM students st JOIN classes c ON c.id=st.class_id
           LEFT JOIN attendance a ON a.student_id=st.id AND a.attendance_date=$3
           WHERE st.school_id=$1 AND c.name=$2 AND st.status='active' ORDER BY st.full_name`,
          [context.school_id, className, attendanceDate],
        );
        json(res, 200, {
          marks: Object.fromEntries(
            result.rows
              .filter((row) => row.status)
              .map((row) => [row.student_id, row.status]),
          ),
          saved:
            result.rows.find((row) => row.recorded_at)?.recorded_at || null,
        });
        return;
      }
      if (req.method === "POST") {
        const data = await readJsonBody(req),
          date = String(data.date || ""),
          selectedClass = String(data.className || "").trim(),
          marks =
            data.marks && typeof data.marks === "object" ? data.marks : {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !selectedClass) {
          json(res, 400, { error: "Choose a valid class and date." });
          return;
        }
        const allowedStatuses = new Set([
          "present",
          "late",
          "absent",
          "excused",
        ]);
        const saved = await transaction(async (client) => {
          const students = (
            await client.query(
              `SELECT st.id FROM students st JOIN classes c ON c.id=st.class_id
               WHERE st.school_id=$1 AND c.name=$2 AND st.status='active'`,
              [context.school_id, selectedClass],
            )
          ).rows;
          const studentIds = new Set(students.map((student) => student.id));
          for (const [studentId, status] of Object.entries(marks)) {
            if (!studentIds.has(studentId) || !allowedStatuses.has(status))
              throw Object.assign(
                new Error("Attendance contains invalid records."),
                {
                  status: 400,
                },
              );
          }
          await client.query(
            `DELETE FROM attendance a USING students st,classes c
             WHERE a.student_id=st.id AND st.class_id=c.id AND st.school_id=$1
             AND c.name=$2 AND a.attendance_date=$3`,
            [context.school_id, selectedClass, date],
          );
          for (const [studentId, status] of Object.entries(marks))
            await client.query(
              `INSERT INTO attendance(school_id,student_id,attendance_date,status,recorded_by,academic_year,term)
               SELECT $1,$2,$3,$4,$5,current_academic_year,current_term FROM schools WHERE id=$1`,
              [context.school_id, studentId, date, status, context.id],
            );
          return new Date().toISOString();
        });
        await recordAudit(context, "attendance.saved", "attendance", null, {
          className: selectedClass,
          date,
          marked: Object.keys(marks).length,
        });
        json(res, 200, { status: "saved", saved });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    if (pathname === "/api/school/timetable") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator", "teacher");
      if (req.method === "GET") {
        const className = String(
          requestUrl.searchParams.get("class") || "",
        ).trim();
        if (!className) {
          json(res, 400, { error: "Choose a class." });
          return;
        }
        const entries = await query(
          `SELECT te.id,te.weekday,to_char(te.start_time,'HH24:MI') AS start_time,
             to_char(te.end_time,'HH24:MI') AS end_time,te.teacher_name,
             c.name AS class_name,su.name AS subject_name
           FROM timetable_entries te JOIN classes c ON c.id=te.class_id
           JOIN subjects su ON su.id=te.subject_id
           JOIN schools sc ON sc.id=te.school_id
           WHERE te.school_id=$1 AND c.name=$2
           AND te.academic_year=sc.current_academic_year AND te.term=sc.current_term
           ORDER BY te.weekday,te.start_time`,
          [context.school_id, className],
        );
        json(res, 200, { entries: entries.rows });
        return;
      }
      if (req.method === "POST") {
        requireRole(context, "administrator");
        const data = await readJsonBody(req),
          className = String(data.className || "").trim(),
          subjectName = String(data.subjectName || "").trim(),
          teacherName = String(data.teacherName || "").trim(),
          weekday = Number(data.weekday),
          startTime = String(data.startTime || ""),
          endTime = String(data.endTime || "");
        if (
          !className ||
          !subjectName ||
          !teacherName ||
          teacherName.length > 100 ||
          !Number.isInteger(weekday) ||
          weekday < 1 ||
          weekday > 7 ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) ||
          endTime <= startTime
        ) {
          json(res, 400, { error: "Enter valid timetable details." });
          return;
        }
        const entry = await transaction(async (client) => {
          const schoolClass = (
              await client.query(
                `SELECT id FROM classes WHERE school_id=$1 AND name=$2`,
                [context.school_id, className],
              )
            ).rows[0],
            subject = (
              await client.query(
                `SELECT id FROM subjects WHERE school_id=$1 AND name=$2`,
                [context.school_id, subjectName],
              )
            ).rows[0];
          if (!schoolClass || !subject)
            throw Object.assign(new Error("Class or subject not found."), {
              status: 404,
            });
          const conflict = (
            await client.query(
              `SELECT te.id FROM timetable_entries te JOIN schools sc ON sc.id=te.school_id
               WHERE te.school_id=$1 AND te.class_id=$2 AND te.weekday=$3
               AND te.academic_year=sc.current_academic_year AND te.term=sc.current_term
               AND start_time<$5::time AND end_time>$4::time LIMIT 1`,
              [context.school_id, schoolClass.id, weekday, startTime, endTime],
            )
          ).rows[0];
          if (conflict)
            throw Object.assign(
              new Error("This class already has a lesson during that time."),
              { status: 409 },
            );
          return (
            await client.query(
              `INSERT INTO timetable_entries(school_id,class_id,subject_id,weekday,start_time,end_time,teacher_name,academic_year,term)
               SELECT $1,$2,$3,$4,$5,$6,$7,current_academic_year,current_term FROM schools WHERE id=$1
               RETURNING id,academic_year,term`,
              [
                context.school_id,
                schoolClass.id,
                subject.id,
                weekday,
                startTime,
                endTime,
                teacherName,
              ],
            )
          ).rows[0];
        });
        await recordAudit(context, "timetable.created", "timetable", entry.id, {
          className,
          subjectName,
          weekday,
          startTime,
          endTime,
          teacherName,
        });
        json(res, 201, { entry });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const timetableRoute = pathname.match(
      /^\/api\/school\/timetable\/([0-9a-f-]{36})$/,
    );
    if (timetableRoute) {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator");
      if (req.method !== "DELETE") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const deleted = (
        await query(
          `DELETE FROM timetable_entries WHERE id=$1 AND school_id=$2 RETURNING id`,
          [timetableRoute[1], context.school_id],
        )
      ).rows[0];
      if (!deleted) {
        json(res, 404, { error: "Timetable entry not found." });
        return;
      }
      await recordAudit(
        context,
        "timetable.removed",
        "timetable",
        deleted.id,
        {},
      );
      json(res, 200, { status: "deleted" });
      return;
    }
    if (pathname === "/api/school/results") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator", "teacher");
      if (req.method === "GET") {
        const className = String(
            requestUrl.searchParams.get("class") || "",
          ).trim(),
          term = String(requestUrl.searchParams.get("term") || "").trim(),
          subjectName = String(
            requestUrl.searchParams.get("subject") || "General",
          ).trim();
        if (!className || !term || !subjectName) {
          json(res, 400, { error: "Choose a valid class, subject and term." });
          return;
        }
        const assessment = (
          await query(
            `SELECT a.id,a.title,a.academic_year,a.term,a.maximum_score,a.published_at,COALESCE(su.name,'General') AS subject_name,
              (SELECT count(*) FROM assessments versions
               WHERE versions.school_id=a.school_id AND versions.class_id=a.class_id
               AND versions.academic_year=a.academic_year AND versions.term=a.term
               AND COALESCE(versions.subject_id::text,'')=COALESCE(a.subject_id::text,'')
               AND versions.published_at IS NOT NULL) AS version
             FROM assessments a JOIN classes c ON c.id=a.class_id
             LEFT JOIN subjects su ON su.id=a.subject_id
             JOIN schools sc ON sc.id=a.school_id
             WHERE a.school_id=$1 AND c.name=$2 AND a.academic_year=sc.current_academic_year
             AND a.term=$3 AND COALESCE(su.name,'General')=$4
             AND a.published_at IS NOT NULL
             ORDER BY a.published_at DESC LIMIT 1`,
            [context.school_id, className, term, subjectName],
          )
        ).rows[0];
        if (!assessment) {
          json(res, 200, { assessment: null, marks: [] });
          return;
        }
        const marks = await query(
          `SELECT st.id AS student_id,st.student_number,st.full_name,am.score,COALESCE(am.remark,'') AS remark
           FROM assessment_marks am JOIN students st ON st.id=am.student_id
           WHERE am.assessment_id=$1 ORDER BY st.full_name`,
          [assessment.id],
        );
        json(res, 200, { assessment, marks: marks.rows });
        return;
      }
      if (req.method === "POST") {
        const data = await readJsonBody(req),
          className = String(data.className || "").trim(),
          term = String(data.term || "").trim(),
          subjectName = String(data.subjectName || "General").trim(),
          marks = Array.isArray(data.marks) ? data.marks : [];
        if (!className || !term || !subjectName || !marks.length) {
          json(res, 400, { error: "Enter a result for every student." });
          return;
        }
        const result = await transaction(async (client) => {
          const schoolClass = (
            await client.query(
              `SELECT id FROM classes WHERE school_id=$1 AND name=$2`,
              [context.school_id, className],
            )
          ).rows[0];
          if (!schoolClass)
            throw Object.assign(new Error("Class not found."), { status: 404 });
          const subject = (
            await client.query(
              `INSERT INTO subjects(school_id,name) VALUES($1,$2)
               ON CONFLICT(school_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
              [context.school_id, subjectName],
            )
          ).rows[0];
          const students = (
            await client.query(
              `SELECT id FROM students WHERE school_id=$1 AND class_id=$2 AND status='active' ORDER BY id`,
              [context.school_id, schoolClass.id],
            )
          ).rows;
          const expectedIds = new Set(students.map((student) => student.id));
          if (
            marks.length !== expectedIds.size ||
            marks.some(
              (mark) =>
                !expectedIds.has(String(mark.studentId)) ||
                !Number.isFinite(Number(mark.score)) ||
                Number(mark.score) < 0 ||
                Number(mark.score) > 100 ||
                String(mark.remark || "").length > 160,
            )
          )
            throw Object.assign(
              new Error(
                "Enter a valid mark for every student before publishing.",
              ),
              { status: 400 },
            );
          const assessment = (
            await client.query(
              `INSERT INTO assessments(school_id,class_id,subject_id,title,term,maximum_score,published_at,academic_year)
               SELECT $1,$2,$3,$4,$5,100,now(),current_academic_year FROM schools WHERE id=$1
               RETURNING id,published_at,academic_year`,
              [
                context.school_id,
                schoolClass.id,
                subject.id,
                `${subjectName} result`,
                term,
              ],
            )
          ).rows[0];
          for (const mark of marks)
            await client.query(
              `INSERT INTO assessment_marks(assessment_id,student_id,score,remark)
               VALUES($1,$2,$3,$4)`,
              [
                assessment.id,
                mark.studentId,
                Number(mark.score),
                String(mark.remark || "").trim() || null,
              ],
            );
          const version = (
            await client.query(
              `SELECT count(*)::int AS count FROM assessments a JOIN schools sc ON sc.id=a.school_id
               WHERE a.school_id=$1 AND a.class_id=$2 AND a.subject_id=$3
               AND a.academic_year=sc.current_academic_year AND a.term=$4 AND a.published_at IS NOT NULL`,
              [context.school_id, schoolClass.id, subject.id, term],
            )
          ).rows[0].count;
          return { ...assessment, version };
        });
        await recordAudit(
          context,
          "results.published",
          "assessment",
          result.id,
          {
            className,
            term,
            subjectName,
            version: result.version,
          },
        );
        json(res, 201, { assessment: result });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    if (pathname === "/api/school/result-terms") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator", "teacher");
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const result = await query(
        `SELECT term FROM (
           SELECT current_term AS term,updated_at AS recorded_at FROM schools WHERE id=$1
           UNION ALL
           SELECT a.term,MAX(a.published_at) AS recorded_at FROM assessments a JOIN schools s ON s.id=a.school_id
           WHERE a.school_id=$1 AND a.academic_year=s.current_academic_year AND a.published_at IS NOT NULL GROUP BY a.term
         ) terms WHERE term IS NOT NULL AND term<>''
         GROUP BY term ORDER BY MAX(recorded_at) DESC`,
        [context.school_id],
      );
      json(res, 200, { terms: result.rows.map((row) => row.term) });
      return;
    }
    if (pathname === "/api/school/report-cards") {
      const context = await requireSchoolContext(req);
      requireRole(context, "administrator", "teacher");
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const className = String(
          requestUrl.searchParams.get("class") || "",
        ).trim(),
        term = String(requestUrl.searchParams.get("term") || "").trim();
      if (!className || !term) {
        json(res, 400, { error: "Choose a valid class and term." });
        return;
      }
      const students = await query(
          `SELECT st.id,st.student_number,st.full_name
           FROM students st JOIN classes c ON c.id=st.class_id
           WHERE st.school_id=$1 AND c.name=$2 AND st.status='active'
           ORDER BY st.full_name`,
          [context.school_id, className],
        ),
        results = await query(
          `WITH latest AS (
             SELECT DISTINCT ON (COALESCE(su.name,'General'))
               a.id,COALESCE(su.name,'General') AS subject_name,a.maximum_score
             FROM assessments a
             JOIN classes c ON c.id=a.class_id
             LEFT JOIN subjects su ON su.id=a.subject_id
             JOIN schools sc ON sc.id=a.school_id
             WHERE a.school_id=$1 AND c.name=$2 AND a.academic_year=sc.current_academic_year AND a.term=$3
               AND a.published_at IS NOT NULL
             ORDER BY COALESCE(su.name,'General'),a.published_at DESC
           )
           SELECT am.student_id,st.student_number,st.full_name,l.subject_name,am.score,l.maximum_score,COALESCE(am.remark,'') AS remark
           FROM latest l JOIN assessment_marks am ON am.assessment_id=l.id
           JOIN students st ON st.id=am.student_id
           ORDER BY l.subject_name`,
          [context.school_id, className, term],
        );
      json(res, 200, {
        className,
        term,
        students: students.rows,
        results: results.rows,
      });
      return;
    }
    if (pathname === "/api/platform/billing") {
      await requirePlatformOwner(req);
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const [schools, payments] = await Promise.all([
        query(
          `SELECT s.id,s.name,s.slug,s.status,s.billing_status,s.trial_status,
                  s.trial_ends_at,s.subscription_paid_until,s.estimated_student_count,
                  COALESCE((SELECT count(*) FROM students st WHERE st.school_id=s.id AND st.status='active'),0)::integer AS student_count,
                  o.administrator_name,o.administrator_email,
                  p.amount_bututs AS last_payment_amount,p.paid_on AS last_payment_date,
                  p.payment_method AS last_payment_method,p.payment_reference AS last_payment_reference
           FROM schools s
           LEFT JOIN school_onboarding o ON o.school_id=s.id
           LEFT JOIN LATERAL (
             SELECT amount_bututs,paid_on,payment_method,payment_reference
             FROM platform_subscription_payments WHERE school_id=s.id
             ORDER BY paid_on DESC,created_at DESC LIMIT 1
           ) p ON true
           ORDER BY s.name`,
        ),
        query(
          `SELECT p.id,p.school_id,s.name AS school_name,p.amount_bututs,p.payment_method,
                  p.payment_reference,p.paid_on,p.coverage_months,p.coverage_ends_on,p.recorded_by
           FROM platform_subscription_payments p JOIN schools s ON s.id=p.school_id
           ORDER BY p.paid_on DESC,p.created_at DESC LIMIT 100`,
        ),
      ]);
      json(res, 200, { schools: schools.rows, payments: payments.rows });
      return;
    }
    if (pathname === "/api/platform/billing/payments") {
      const owner = await requirePlatformOwner(req);
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        schoolId = String(data.schoolId || ""),
        amountBututs = Math.round(Number(data.amount) * 100),
        method = String(data.paymentMethod || ""),
        reference = String(data.reference || "").trim() || null,
        paidOn = String(data.paidOn || ""),
        coverageMonths = Number(data.coverageMonths);
      if (
        !/^[0-9a-f-]{36}$/.test(schoolId) ||
        !Number.isSafeInteger(amountBututs) || amountBututs <= 0 ||
        !["cash", "wave", "bank_transfer", "card", "other"].includes(method) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(paidOn) ||
        !Number.isInteger(coverageMonths) || coverageMonths < 1 || coverageMonths > 24
      ) {
        json(res, 400, { error: "Enter valid subscription payment details." });
        return;
      }
      const payment = await transaction(async (client) => {
        const school = (await client.query(`SELECT id FROM schools WHERE id=$1 FOR UPDATE`, [schoolId])).rows[0];
        if (!school) throw Object.assign(new Error("School not found."), { status: 404 });
        const result = await client.query(
          `WITH coverage AS (
             SELECT (GREATEST(COALESCE(subscription_paid_until,CURRENT_DATE),CURRENT_DATE)
                     + ($6::integer * interval '1 month'))::date AS ends_on
             FROM schools WHERE id=$1
           ), inserted AS (
             INSERT INTO platform_subscription_payments
               (school_id,amount_bututs,payment_method,payment_reference,paid_on,coverage_months,coverage_ends_on,recorded_by)
             SELECT $1,$2,$3,$4,$5,$6,ends_on,$7 FROM coverage
             RETURNING *
           )
           UPDATE schools SET billing_status='paid',subscription_paid_until=inserted.coverage_ends_on,
                  status=CASE WHEN status='suspended' THEN 'active' ELSE status END,updated_at=now()
           FROM inserted WHERE schools.id=$1 RETURNING inserted.*`,
          [schoolId, amountBututs, method, reference, paidOn, coverageMonths, owner.email],
        );
        return result.rows[0];
      });
      json(res, 201, { payment });
      return;
    }
    const billingSchool = pathname.match(/^\/api\/platform\/billing\/schools\/([0-9a-f-]{36})$/);
    if (billingSchool) {
      await requirePlatformOwner(req);
      if (req.method !== "PATCH") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req), action = String(data.action || "");
      if (!["suspend", "reactivate"].includes(action)) {
        json(res, 400, { error: "Choose suspend or reactivate." });
        return;
      }
      const result = await query(
        `UPDATE schools SET billing_status=$2,status=$3,updated_at=now() WHERE id=$1
         AND status NOT IN ('cancelled','pending_deletion') RETURNING id,name,status,billing_status`,
        [billingSchool[1], action === "suspend" ? "suspended" : "unpaid", action === "suspend" ? "suspended" : "active"],
      );
      if (!result.rows[0]) {
        json(res, 404, { error: "School cannot be updated." });
        return;
      }
      json(res, 200, { school: result.rows[0] });
      return;
    }
    if (pathname === "/api/platform/schools") {
      await requirePlatformOwner(req);
      if (req.method === "GET") {
        const result = await query(
          `SELECT s.id,s.name,s.slug,s.school_type,s.region,s.district,s.status,s.created_at,
                  s.cancellation_requested_at,s.retention_until,s.deletion_requested_at,
                  s.onboarding_mode,s.trial_requested,s.trial_status,s.trial_started_at,s.trial_ends_at,
                  o.administrator_name,o.administrator_email,o.invitation_status,o.invited_at,o.invitation_expires_at
           FROM schools s LEFT JOIN school_onboarding o ON o.school_id=s.id ORDER BY s.created_at DESC`,
        );
        json(res, 200, { schools: result.rows });
        return;
      }
      if (req.method === "POST") {
        const data = await readJsonBody(req),
          name = String(data.name || "").trim(),
          schoolType = String(data.schoolType || "public"),
          slug = String(data.slug || "")
            .trim()
            .toLowerCase(),
          adminName = String(data.administratorName || "").trim(),
          adminEmail = String(data.administratorEmail || "")
            .trim()
            .toLowerCase();
        if (
          !name ||
          !adminName ||
          ![
            "public",
            "private",
            "mission",
            "community",
            "vocational",
            "training_centre",
            "college",
          ].includes(schoolType) ||
          !/^[-a-z0-9]{3,60}$/.test(slug) ||
          !/^\S+@\S+\.\S+$/.test(adminEmail)
        ) {
          json(res, 400, {
            error: "Enter valid school and administrator details.",
          });
          return;
        }
        const invite = invitation();
        const record = await transaction(async (client) => {
          const school = (
            await client.query(
              `INSERT INTO schools(name,slug,school_type,region,district,contact_name,contact_email,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id,name`,
              [
                name,
                slug,
                schoolType,
                String(data.region || "").trim() || null,
                String(data.district || "").trim() || null,
                adminName,
                adminEmail,
              ],
            )
          ).rows[0];
          await client.query(
            `INSERT INTO school_onboarding(school_id,administrator_name,administrator_email,invitation_status,invitation_token_hash,invitation_expires_at,invited_at) VALUES($1,$2,$3,'sent',$4,$5,now())`,
            [school.id, adminName, adminEmail, invite.hash, invite.expiresAt],
          );
          return {
            ...school,
            administrator_name: adminName,
            administrator_email: adminEmail,
          };
        });
        try {
          await emailInvitation(record, invite);
          json(res, 201, {
            id: record.id,
            status: "pending",
            invitation: "sent",
          });
        } catch (error) {
          console.error("[email] invitation failed:", error.message);
          await query(
            `UPDATE school_onboarding SET invitation_status='email_failed' WHERE school_id=$1`,
            [record.id],
          );
          json(res, 201, {
            id: record.id,
            status: "pending",
            invitation: "email_failed",
            warning:
              "School created, but the invitation email could not be sent. Check SMTP settings and use Resend.",
          });
        }
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const schoolLifecycle = pathname.match(
      /^\/api\/platform\/schools\/([0-9a-f-]{36})$/,
    );
    if (schoolLifecycle) {
      const owner = await requirePlatformOwner(req);
      if (req.method === "PATCH") {
        const school = (
          await query(
            `UPDATE schools SET status='active',cancellation_requested_at=NULL,
                    retention_until=NULL,deletion_requested_at=NULL,cancellation_reason=NULL,updated_at=now()
             WHERE id=$1 AND status IN ('cancelled','pending_deletion')
             RETURNING id,name,status`,
            [schoolLifecycle[1]],
          )
        ).rows[0];
        if (!school) {
          json(res, 404, { error: "Cancelled school not found." });
          return;
        }
        json(res, 200, { school });
        return;
      }
      if (req.method === "DELETE") {
        const data = await readJsonBody(req),
          confirmation = String(data.confirmation || "").trim();
        const school = (
          await query(
            `SELECT s.id,s.name,s.status,s.retention_until,s.deletion_requested_at,
                    o.accepted_at,
                    EXISTS(SELECT 1 FROM school_users su WHERE su.school_id=s.id) AS has_users
             FROM schools s LEFT JOIN school_onboarding o ON o.school_id=s.id
             WHERE s.id=$1`,
            [schoolLifecycle[1]],
          )
        ).rows[0];
        const pendingUnused =
            school?.status === "pending" && !school.accepted_at && !school.has_users,
          eligible =
          school &&
          (pendingUnused || school.deletion_requested_at ||
            (school.retention_until && new Date(school.retention_until) <= new Date()));
        if (!eligible || confirmation !== school.name) {
          json(res, 409, {
            error: "Deletion is not yet eligible or the school name does not match.",
          });
          return;
        }
        await transaction(async (client) => {
          if (!pendingUnused)
            await client.query(
              `UPDATE school_data_deletions SET completed_by=$2,completed_at=now()
               WHERE school_id=$1 AND completed_at IS NULL`,
              [school.id, owner.email],
            );
          await client.query(`DELETE FROM schools WHERE id=$1`, [school.id]);
        });
        json(res, 200, { status: "deleted" });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const resend = pathname.match(
      /^\/api\/platform\/schools\/([0-9a-f-]{36})\/resend-invitation$/,
    );
    if (resend) {
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      await requirePlatformOwner(req);
      const invite = invitation();
      const result = await query(
        `UPDATE school_onboarding o SET invitation_token_hash=$2,invitation_expires_at=$3,invited_at=now(),invitation_status='sent' FROM schools s WHERE o.school_id=$1 AND s.id=o.school_id AND o.accepted_at IS NULL RETURNING s.name,o.administrator_name,o.administrator_email`,
        [resend[1], invite.hash, invite.expiresAt],
      );
      if (!result.rows[0]) {
        json(res, 404, { error: "Pending invitation not found." });
        return;
      }
      try {
        await emailInvitation(result.rows[0], invite);
        json(res, 200, { status: "sent" });
      } catch (error) {
        console.error("[email] resend failed:", error.message);
        await query(
          `UPDATE school_onboarding SET invitation_status='email_failed' WHERE school_id=$1`,
          [resend[1]],
        );
        json(res, 502, {
          error:
            "Invitation email failed. Check the SMTP settings and try again.",
        });
      }
      return;
    }
    const inviteRoute = pathname.match(
      /^\/api\/invitations\/([A-Za-z0-9_-]{40,100})$/,
    );
    if (inviteRoute) {
      const hash = tokenHash(inviteRoute[1]);
      if (req.method === "GET") {
        let result = await query(
          `SELECT s.name,o.administrator_name,o.administrator_email,o.invitation_expires_at FROM school_onboarding o JOIN schools s ON s.id=o.school_id WHERE o.invitation_token_hash=$1 AND o.accepted_at IS NULL AND o.invitation_expires_at>now()`,
          [hash],
        );
        if (!result.rows[0])
          result = await query(
            `SELECT s.name,si.full_name AS administrator_name,si.email AS administrator_email,si.role,si.invitation_expires_at
             FROM staff_invitations si JOIN schools s ON s.id=si.school_id
             WHERE si.invitation_token_hash=$1 AND si.accepted_at IS NULL AND si.invitation_expires_at>now()`,
            [hash],
          );
        if (!result.rows[0]) {
          json(res, 404, {
            error: "This invitation is invalid or has expired.",
          });
          return;
        }
        json(res, 200, { invitation: result.rows[0] });
        return;
      }
      if (req.method === "POST") {
        const user = await verifyAuthenticatedUser(req);
        const result = await transaction(async (client) => {
          let found = (
            await client.query(
              `SELECT o.school_id,o.administrator_email,s.trial_requested
               FROM school_onboarding o JOIN schools s ON s.id=o.school_id
               WHERE o.invitation_token_hash=$1 AND o.accepted_at IS NULL
                 AND o.invitation_expires_at>now() FOR UPDATE OF o`,
              [hash],
            )
          ).rows[0];
          let staffInvite = false;
          if (!found) {
            found = (
              await client.query(
                `SELECT school_id,email AS administrator_email,role,id FROM staff_invitations
                 WHERE invitation_token_hash=$1 AND accepted_at IS NULL AND invitation_expires_at>now() FOR UPDATE`,
                [hash],
              )
            ).rows[0];
            staffInvite = Boolean(found);
          }
          if (!found)
            throw Object.assign(
              new Error("This invitation is invalid or has expired."),
              { status: 404 },
            );
          if (user.email !== found.administrator_email.toLowerCase())
            throw Object.assign(
              new Error(
                "Sign in with the email address that received this invitation.",
              ),
              { status: 403 },
            );
          await client.query(
            `INSERT INTO school_users(school_id,auth_user_id,role) VALUES($1,$2,$3)
             ON CONFLICT(school_id,auth_user_id) DO UPDATE SET role=EXCLUDED.role`,
            [
              found.school_id,
              user.id,
              staffInvite ? found.role : "administrator",
            ],
          );
          if (staffInvite)
            await client.query(
              `UPDATE staff_invitations SET invitation_status='accepted',accepted_at=now(),auth_user_id=$2,invitation_token_hash=NULL WHERE id=$1`,
              [found.id, user.id],
            );
          else {
            let trialGranted = false;
            if (found.trial_requested) {
              await client.query(`SELECT pg_advisory_xact_lock(20261002)`);
              const trialCount = Number(
                (
                  await client.query(
                    `SELECT count(*)::integer AS total FROM schools WHERE trial_started_at IS NOT NULL`,
                  )
                ).rows[0].total,
              );
              trialGranted = trialCount < 10;
            }
            await client.query(
              `UPDATE school_onboarding SET invitation_status='accepted',accepted_at=now(),auth_user_id=$2,invitation_token_hash=NULL WHERE school_id=$1`,
              [found.school_id, user.id],
            );
            await client.query(
              `UPDATE schools SET status='active',
                       trial_status=CASE WHEN $2 THEN 'active' ELSE trial_status END,
                       trial_started_at=CASE WHEN $2 THEN now() ELSE trial_started_at END,
                       trial_ends_at=CASE WHEN $2 THEN now() + interval '2 months' ELSE trial_ends_at END,
                       updated_at=now()
               WHERE id=$1`,
              [found.school_id, trialGranted],
            );
            found.trialGranted = trialGranted;
          }
          return found;
        });
        json(res, 200, {
          status: "accepted",
          schoolId: result.school_id,
          trialGranted: Boolean(result.trialGranted),
        });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const publicPath =
      pathname === "/product"
        ? "/product.html"
        : pathname === "/onboarding"
          ? "/onboarding.html"
          : pathname === "/admissions"
            ? "/admissions.html"
          : pathname;
    const target = path.resolve(
      root,
      "." + (publicPath === "/" ? "/index.html" : publicPath),
    );
    if (!target.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const fileBody = await readFile(target);
    res.writeHead(200, {
      "Content-Type": types[path.extname(target)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://ep-spring-poetry-b2x3am6k.neonauth.c-6.eu-central-1.aws.neon.tech; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    res.end(fileBody);
  } catch (error) {
    const failedPath = new URL(req.url, "http://localhost").pathname;
    if (failedPath.startsWith("/api/")) {
      console.error(
        `[api] ${req.method} ${failedPath} failed:`,
        error instanceof Error ? error.message : error,
      );
      const duplicate = error?.code === "23505";
      json(res, duplicate ? 409 : error.status || 500, {
        error: duplicate
          ? "That student or school code is already in use."
          : error.status
            ? error.message
            : "Request failed",
      });
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  }
});
await initializeDatabase();
server.listen(
  Number(process.env.PORT || 3000),
  process.env.HOST || "0.0.0.0",
  () =>
    console.log(
      `School portal: http://${process.env.HOST || "0.0.0.0"}:${process.env.PORT || 3000}`,
    ),
);
