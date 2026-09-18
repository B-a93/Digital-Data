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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
