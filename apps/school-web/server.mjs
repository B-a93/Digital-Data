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
import { sendSchoolInvitation } from "./mailer.mjs";
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
    if (value.length > 20000)
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
        `SELECT su.role,s.id,s.name,s.slug,s.current_term,s.status
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
          status: row.status,
        },
      });
      return;
    }
    if (pathname === "/api/school/students") {
      const context = await requireSchoolContext(req);
      if (req.method === "GET") {
        const [students, schoolClasses] = await Promise.all([
          query(
            `SELECT st.id,st.student_number,st.full_name,st.status,c.name AS class_name
             FROM students st LEFT JOIN classes c ON c.id=st.class_id
             WHERE st.school_id=$1 ORDER BY st.full_name`,
            [context.school_id],
          ),
          query(
            `SELECT id,name FROM classes WHERE school_id=$1 ORDER BY name`,
            [context.school_id],
          ),
        ]);
        json(res, 200, {
          students: students.rows,
          classes: schoolClasses.rows,
        });
        return;
      }
      if (req.method === "POST") {
        const data = await readJsonBody(req),
          studentNumber = String(data.studentNumber || "")
            .trim()
            .toUpperCase(),
          fullName = String(data.fullName || "").trim(),
          className = String(data.className || "").trim();
        if (
          !/^[A-Z0-9][A-Z0-9\-/]{1,29}$/.test(studentNumber) ||
          !fullName ||
          !className
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
              `INSERT INTO students(school_id,class_id,student_number,full_name)
               VALUES($1,$2,$3,$4)
               RETURNING id,student_number,full_name,status`,
              [context.school_id, schoolClass.id, studentNumber, fullName],
            )
          ).rows[0];
        });
        json(res, 201, { student });
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const studentRoute = pathname.match(
      /^\/api\/school\/students\/([0-9a-f-]{36})$/,
    );
    if (studentRoute) {
      const context = await requireSchoolContext(req);
      if (req.method !== "PATCH") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const data = await readJsonBody(req),
        studentNumber = String(data.studentNumber || "")
          .trim()
          .toUpperCase(),
        fullName = String(data.fullName || "").trim(),
        className = String(data.className || "").trim();
      if (
        !/^[A-Z0-9][A-Z0-9\-/]{1,29}$/.test(studentNumber) ||
        !fullName ||
        !className
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
            `UPDATE students SET student_number=$3,full_name=$4,class_id=$5,updated_at=now()
             WHERE id=$1 AND school_id=$2
             RETURNING id,student_number,full_name,status`,
            [
              studentRoute[1],
              context.school_id,
              studentNumber,
              fullName,
              schoolClass.id,
            ],
          )
        ).rows[0];
      });
      if (!updated) {
        json(res, 404, { error: "Student not found." });
        return;
      }
      json(res, 200, { student: updated });
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
        const result = await query(
          `SELECT s.name,o.administrator_name,o.administrator_email,o.invitation_expires_at FROM school_onboarding o JOIN schools s ON s.id=o.school_id WHERE o.invitation_token_hash=$1 AND o.accepted_at IS NULL AND o.invitation_expires_at>now()`,
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
          const found = (
            await client.query(
              `SELECT o.school_id,o.administrator_email FROM school_onboarding o WHERE o.invitation_token_hash=$1 AND o.accepted_at IS NULL AND o.invitation_expires_at>now() FOR UPDATE`,
              [hash],
            )
          ).rows[0];
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
            `INSERT INTO school_users(school_id,auth_user_id,role) VALUES($1,$2,'administrator') ON CONFLICT(school_id,auth_user_id) DO UPDATE SET role='administrator'`,
            [found.school_id, user.id],
          );
          await client.query(
            `UPDATE school_onboarding SET invitation_status='accepted',accepted_at=now(),auth_user_id=$2,invitation_token_hash=NULL WHERE school_id=$1`,
            [found.school_id, user.id],
          );
          await client.query(
            `UPDATE schools SET status='active',updated_at=now() WHERE id=$1`,
            [found.school_id],
          );
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
