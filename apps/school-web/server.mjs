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
import { sendSchoolInvitation, sendStaffInvitation } from "./mailer.mjs";
const root = path.resolve(fileURLToPath(new URL("./public/", import.meta.url)));
const neonAuthUrl =
  "https://ep-spring-poetry-b2x3am6k.neonauth.c-6.eu-central-1.aws.neon.tech/neondb/auth";
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const json = (res, status, data) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
};
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
        `SELECT su.role,s.id,s.name,s.slug,s.current_term,s.pass_mark,s.grade_scale,s.status
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
          term: row.current_term,
          passMark: Number(row.pass_mark),
          gradeScale: row.grade_scale,
          status: row.status,
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
    if (pathname === "/api/school/students") {
      const context = await requireSchoolContext(req);
      if (req.method === "GET") {
        const [students, schoolClasses, subjects] = await Promise.all([
          query(
            `SELECT st.id,st.student_number,st.full_name,st.guardian_name,st.guardian_phone,st.status,c.name AS class_name
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
          guardianPhone = String(data.guardianPhone || "").trim();
        if (
          !/^[A-Z0-9][A-Z0-9\-/]{1,29}$/.test(studentNumber) ||
          !fullName ||
          !className ||
          guardianName.length > 100 ||
          guardianPhone.length > 40
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
          return (
            await client.query(
              `INSERT INTO students(school_id,class_id,student_number,full_name,guardian_name,guardian_phone)
               VALUES($1,$2,$3,$4,$5,$6)
               RETURNING id,student_number,full_name,guardian_name,guardian_phone,status`,
              [
                context.school_id,
                schoolClass.id,
                studentNumber,
                fullName,
                guardianName || null,
                guardianPhone || null,
              ],
            )
          ).rows[0];
        });
        await recordAudit(context, "student.created", "student", student.id, {
          studentNumber,
          fullName,
          className,
          guardianName,
          guardianPhone,
        });
        json(res, 201, { student });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
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
          await client.query(
            `INSERT INTO students(school_id,class_id,student_number,full_name,guardian_name,guardian_phone)
             VALUES($1,$2,$3,$4,$5,$6)`,
            [
              context.school_id,
              classIds.get(row.className),
              row.studentNumber,
              row.fullName,
              row.guardianName || null,
              row.guardianPhone || null,
            ],
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
          `UPDATE schools SET name=$2,current_term=$3,pass_mark=$4,grade_scale=$5,updated_at=now()
           WHERE id=$1 RETURNING id,name,current_term,pass_mark,grade_scale`,
          [context.school_id, name, term, passMark, gradeScale],
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
      if (data.status !== undefined) {
        const status = String(data.status).toLowerCase();
        if (!["active", "inactive", "graduated"].includes(status)) {
          json(res, 400, { error: "Choose a valid student status." });
          return;
        }
        const student = (
          await query(
            `UPDATE students SET status=$3,updated_at=now() WHERE id=$1 AND school_id=$2
             RETURNING id,student_number,full_name,status`,
            [studentRoute[1], context.school_id, status],
          )
        ).rows[0];
        if (!student) {
          json(res, 404, { error: "Student not found." });
          return;
        }
        await recordAudit(
          context,
          "student.status_changed",
          "student",
          student.id,
          {
            status,
          },
        );
        json(res, 200, { student });
        return;
      }
      const studentNumber = String(data.studentNumber || "")
          .trim()
          .toUpperCase(),
        fullName = String(data.fullName || "").trim(),
        className = String(data.className || "").trim(),
        guardianName = String(data.guardianName || "").trim(),
        guardianPhone = String(data.guardianPhone || "").trim();
      if (
        !/^[A-Z0-9][A-Z0-9\-/]{1,29}$/.test(studentNumber) ||
        !fullName ||
        !className ||
        guardianName.length > 100 ||
        guardianPhone.length > 40
      ) {
        json(res, 400, { error: "Enter valid student details." });
        return;
      }
      const updated = await transaction(async (client) => {
        const schoolClass = (
          await client.query(
            `INSERT INTO classes(school_id,name) VALUES($1,$2)
             ON CONFLICT(school_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
            [context.school_id, className],
          )
        ).rows[0];
        return (
          await client.query(
            `UPDATE students SET student_number=$3,full_name=$4,class_id=$5,guardian_name=$6,guardian_phone=$7,updated_at=now()
             WHERE id=$1 AND school_id=$2
             RETURNING id,student_number,full_name,guardian_name,guardian_phone,status`,
            [
              studentRoute[1],
              context.school_id,
              studentNumber,
              fullName,
              schoolClass.id,
              guardianName || null,
              guardianPhone || null,
            ],
          )
        ).rows[0];
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
      const [feeTypes, charges, payments] = await Promise.all([
        query(
          `SELECT id,name FROM fee_types WHERE school_id=$1 ORDER BY name`,
          [context.school_id],
        ),
        query(
          `SELECT fc.id,fc.student_id,fc.description,fc.amount_bututs,fc.created_at
           FROM fee_charges fc WHERE fc.school_id=$1 ORDER BY fc.created_at`,
          [context.school_id],
        ),
        query(
          `SELECT p.id,p.student_id,p.amount_bututs,p.receipt_number,p.paid_on,p.created_at
           FROM payments p WHERE p.school_id=$1 ORDER BY p.created_at`,
          [context.school_id],
        ),
      ]);
      json(res, 200, {
        feeTypes: feeTypes.rows,
        charges: charges.rows,
        payments: payments.rows,
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
        amount = Number(data.amountBututs);
      if (
        !/^[0-9a-f-]{36}$/.test(studentId) ||
        !description ||
        !Number.isSafeInteger(amount) ||
        amount <= 0
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
            `INSERT INTO fee_charges(school_id,student_id,fee_type_id,description,amount_bututs)
             VALUES($1,$2,$3,$4,$5)
             RETURNING id,student_id,description,amount_bututs,created_at`,
            [context.school_id, studentId, feeType.id, description, amount],
          )
        ).rows[0];
      });
      await recordAudit(context, "charge.created", "charge", charge.id, {
        studentId,
        description,
        amountBututs: amount,
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
        amount = Number(data.amountBututs);
      if (
        !className ||
        !description ||
        !Number.isSafeInteger(amount) ||
        amount <= 0
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
            `INSERT INTO fee_charges(school_id,student_id,fee_type_id,description,amount_bututs)
             VALUES($1,$2,$3,$4,$5)`,
            [context.school_id, student.id, feeType.id, description, amount],
          );
        return students.length;
      });
      await recordAudit(context, "class_charge.created", "charge", null, {
        className,
        description,
        amountBututs: amount,
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
          `INSERT INTO payments(school_id,student_id,amount_bututs,receipt_number,operation_key,paid_on,recorded_by)
           VALUES($1,$2,$3,$4,$5,CURRENT_DATE,$6)
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
              `INSERT INTO attendance(school_id,student_id,attendance_date,status,recorded_by)
               VALUES($1,$2,$3,$4,$5)`,
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
            `SELECT a.id,a.title,a.term,a.maximum_score,a.published_at,COALESCE(su.name,'General') AS subject_name,
              (SELECT count(*) FROM assessments versions
               WHERE versions.school_id=a.school_id AND versions.class_id=a.class_id
               AND versions.term=a.term AND COALESCE(versions.subject_id::text,'')=COALESCE(a.subject_id::text,'')
               AND versions.published_at IS NOT NULL) AS version
             FROM assessments a JOIN classes c ON c.id=a.class_id
             LEFT JOIN subjects su ON su.id=a.subject_id
             WHERE a.school_id=$1 AND c.name=$2 AND a.term=$3 AND COALESCE(su.name,'General')=$4
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
              `INSERT INTO assessments(school_id,class_id,subject_id,title,term,maximum_score,published_at)
               VALUES($1,$2,$3,$4,$5,100,now()) RETURNING id,published_at`,
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
              `SELECT count(*)::int AS count FROM assessments
               WHERE school_id=$1 AND class_id=$2 AND subject_id=$3 AND term=$4 AND published_at IS NOT NULL`,
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
             WHERE a.school_id=$1 AND c.name=$2 AND a.term=$3
               AND a.published_at IS NOT NULL
             ORDER BY COALESCE(su.name,'General'),a.published_at DESC
           )
           SELECT am.student_id,l.subject_name,am.score,l.maximum_score,COALESCE(am.remark,'') AS remark
           FROM latest l JOIN assessment_marks am ON am.assessment_id=l.id
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
    if (pathname === "/api/platform/schools") {
      await requirePlatformOwner(req);
      if (req.method === "GET") {
        const result = await query(
          `SELECT s.id,s.name,s.slug,s.school_type,s.region,s.district,s.status,s.created_at,o.administrator_name,o.administrator_email,o.invitation_status,o.invited_at,o.invitation_expires_at FROM schools s LEFT JOIN school_onboarding o ON o.school_id=s.id ORDER BY s.created_at DESC`,
        );
        json(res, 200, { schools: result.rows });
        return;
      }
      if (req.method === "POST") {
        const data = await readJsonBody(req),
          name = String(data.name || "").trim(),
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
                String(data.schoolType || "public"),
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
              `SELECT o.school_id,o.administrator_email FROM school_onboarding o WHERE o.invitation_token_hash=$1 AND o.accepted_at IS NULL AND o.invitation_expires_at>now() FOR UPDATE`,
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
            await client.query(
              `UPDATE school_onboarding SET invitation_status='accepted',accepted_at=now(),auth_user_id=$2,invitation_token_hash=NULL WHERE school_id=$1`,
              [found.school_id, user.id],
            );
            await client.query(
              `UPDATE schools SET status='active',updated_at=now() WHERE id=$1`,
              [found.school_id],
            );
          }
          return found;
        });
        json(res, 200, { status: "accepted", schoolId: result.school_id });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const target = path.resolve(
      root,
      "." + (pathname === "/" ? "/index.html" : pathname),
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
