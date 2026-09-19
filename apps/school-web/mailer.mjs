import nodemailer from "nodemailer";

function config() {
  const host = process.env.SMTP_HOST?.trim(),
    user = process.env.SMTP_USER?.trim(),
    pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) throw new Error("SMTP is not configured");
  const port = Number(process.env.SMTP_PORT || 465);
  return { host, port, secure: port === 465, auth: { user, pass } };
}

export async function sendSchoolInvitation({
  to,
  name,
  school,
  link,
  expiresAt,
}) {
  const transporter = nodemailer.createTransport(config());
  const from = process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim();
  const date = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Africa/Banjul",
  }).format(expiresAt);
  await transporter.sendMail({
    from,
    to,
    subject: `Activate your ${school} school portal`,
    text: `Hello ${name},\n\nElegant Empire AI has created a School Management Portal for ${school}. Activate your administrator account using this secure link:\n\n${link}\n\nThe link expires on ${date} (Gambia time). If you were not expecting this invitation, ignore this email.`,
    html: `<p>Hello ${escapeHtml(name)},</p><p>Elegant Empire AI has created a School Management Portal for <strong>${escapeHtml(school)}</strong>.</p><p><a href="${escapeHtml(link)}">Activate your administrator account</a></p><p>This secure link expires on ${escapeHtml(date)} (Gambia time). If you were not expecting this invitation, ignore this email.</p>`,
  });
}

export async function sendStaffInvitation({
  to,
  name,
  school,
  role,
  link,
  expiresAt,
}) {
  const transporter = nodemailer.createTransport(config());
  const from = process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim();
  const date = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Africa/Banjul",
  }).format(expiresAt);
  const roleName = role === "finance" ? "Finance" : "Teacher";
  await transporter.sendMail({
    from,
    to,
    subject: `Join ${school} as ${roleName}`,
    text: `Hello ${name},\n\nYou have been invited to the ${school} School Management Portal as ${roleName}. Create your account using this secure link:\n\n${link}\n\nThe link expires on ${date} (Gambia time).`,
    html: `<p>Hello ${escapeHtml(name)},</p><p>You have been invited to the <strong>${escapeHtml(school)}</strong> School Management Portal as <strong>${roleName}</strong>.</p><p><a href="${escapeHtml(link)}">Create your staff account</a></p><p>This secure link expires on ${escapeHtml(date)} (Gambia time).</p>`,
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
