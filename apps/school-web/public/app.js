import {
  classes,
  seed,
  cents,
  balance,
  recordPayment,
  attendanceSummary,
  csv,
  publishResults,
} from "./domain.js";
import { createAuthClient } from "@neondatabase/auth";
const auth = createAuthClient(location.origin + "/api/auth");
const $ = (s) => document.querySelector(s),
  key = "digital-data-school-demo-v1";
let state;
let storageWarning = false;
try {
  state = JSON.parse(localStorage.getItem(key));
  if (!state || state.version !== 1) state = seed();
} catch {
  state = seed();
  storageWarning = true;
}
state.settings.classes ||= [
  ...new Set([
    ...classes,
    ...state.students.map((s) => s.class).filter(Boolean),
  ]),
];
state.settings.feeTypes ||= [
  ...new Set([
    "Term tuition",
    ...state.charges.map((c) => c.label).filter(Boolean),
  ]),
];
state.settings.subjects ||= [];
let view = "dashboard",
  selectedClass = state.settings.classes[0],
  selectedSubject = state.settings.subjects?.[0] || "General",
  selectedDate = localDate(),
  search = "",
  studentClass = "",
  studentStatus = "active",
  operation = crypto.randomUUID(),
  role = "Administrator",
  editingStudentId = null,
  accessToken = "",
  isPlatformOwner = false,
  activeSchool = null,
  schoolDataLive = false,
  schoolClassIds = new Map(),
  schoolFeeTypeIds = new Map(),
  schoolSubjectIds = new Map(),
  platformSchools = [],
  schoolStaff = [],
  schoolActivity = [];
let attendanceDraft = null;
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const money = (n) =>
  "D" +
  (n / 100).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const schoolClasses = () => state.settings.classes;
const schoolSubjects = () =>
  state.settings.subjects.length ? state.settings.subjects : ["General"];
const activeStudents = () =>
  state.students.filter((student) => (student.status || "active") === "active");
const options = (items, current) =>
  items
    .map(
      (x) =>
        `<option ${x === current ? "selected" : ""} value="${esc(x)}">${esc(x)}</option>`,
    )
    .join("");
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("visible"), 5000);
}
function save() {
  try {
    localStorage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    toast(
      "Browser storage unavailable. Changes are in memory only; export before leaving.",
    );
    return false;
  }
}
const navItems = [
  ["dashboard", "◫", "Overview"],
  ["students", "♙", "Students"],
  ["attendance", "✓", "Attendance"],
  ["fees", "◈", "Fees & payments"],
  ["results", "▤", "Results"],
  ["reports", "↗", "Reports"],
  ["staff", "♧", "Staff"],
  ["activity", "◷", "Activity"],
  ["settings", "⚙", "Settings"],
];
const visibleNav = () =>
  isPlatformOwner
    ? [["platform", "◆", "School onboarding"], ...navItems]
    : !schoolDataLive || role === "Administrator"
      ? navItems
      : role === "Teacher"
        ? navItems.filter(([id]) =>
            ["dashboard", "students", "attendance", "results"].includes(id),
          )
        : navItems.filter(([id]) =>
            ["dashboard", "students", "fees", "reports"].includes(id),
          );
function heading(title, subtitle, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
function table(heads, rows) {
  return `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${heads.length}" class="empty">No matching records.</td></tr>`}</tbody></table></div>`;
}
function studentCell(s) {
  return `<span class="student-name">${esc(s.name)}</span><span class="sub">${esc(s.admission)}</span>${s.guardianName || s.guardianPhone ? `<span class="sub">Guardian: ${esc(s.guardianName || "—")}${s.guardianPhone ? ` · ${esc(s.guardianPhone)}` : ""}</span>` : ""}`;
}
function badge(n) {
  return n > 0
    ? '<span class="badge amber">Outstanding</span>'
    : n < 0
      ? '<span class="badge">Credit</span>'
      : '<span class="badge">Paid</span>';
}
function parseCsvText(text) {
  const rows = [];
  let row = [],
    value = "",
    quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      row.push(value.trim());
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
function downloadStudentTemplate() {
  const content = csv([
      [
        "Student number",
        "Full name",
        "Class",
        "Guardian name",
        "Guardian phone",
      ],
      [
        "STU-2026-001",
        "Example Student",
        "Grade 7 A",
        "Example Guardian",
        "+220 000 0000",
      ],
    ]),
    blob = new Blob(["\ufeff" + content], { type: "text/csv;charset=utf-8" }),
    url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "student-import-template.csv";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function navigate(next) {
  if (
    attendanceDraft &&
    view === "attendance" &&
    !confirm("Leave unsaved attendance changes?")
  )
    return;
  attendanceDraft = null;
  location.hash = next;
  render();
}
function render() {
  view = location.hash.slice(1) || "dashboard";
  if (!visibleNav().some((n) => n[0] === view)) view = "dashboard";
  $("#nav").innerHTML = visibleNav()
    .map(
      ([id, icon, label]) =>
        `<a href="#${id}" data-nav="${id}" class="${view === id ? "active" : ""}" ${view === id ? 'aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</a>`,
    )
    .join("");
  $("#term").textContent = state.settings.term;
  $("#school-name").textContent = isPlatformOwner
    ? "Elegant Empire AI"
    : state.settings.name;
  $("#content").innerHTML = {
    dashboard,
    students,
    attendance,
    fees,
    results,
    reports,
    staff,
    activity,
    settings,
    platform,
  }[view]();
  wire();
}
function platform() {
  return (
    heading(
      "School onboarding",
      "Create and monitor protected school workspaces.",
    ) +
    `<div class="stack"><section class="panel"><div class="panel-heading"><h2>Create a school workspace</h2><span class="badge gray">Platform Owner</span></div><form id="school-onboarding-form"><div class="form-grid"><div class="field"><label>School name</label><input name="name" maxlength="100" required></div><div class="field"><label>School code</label><input name="slug" maxlength="60" pattern="[-a-z0-9]{3,60}" placeholder="e.g. brikama-primary" required></div><div class="field"><label>School type</label><select name="schoolType"><option value="public">Public</option><option value="private">Private</option><option value="mission">Mission</option><option value="community">Community</option></select></div><div class="field"><label>Region</label><input name="region" maxlength="80"></div><div class="field"><label>District</label><input name="district" maxlength="80"></div><div class="field"><label>Administrator name</label><input name="administratorName" maxlength="100" required></div><div class="field"><label>Administrator email</label><input name="administratorEmail" type="email" required></div></div><div class="form-actions"><button class="button">Create school and send invitation</button></div><div id="platform-error" class="error" role="alert"></div></form></section><section class="panel"><div class="panel-heading"><h2>School workspaces</h2><button id="refresh-schools" class="text-button">Refresh</button></div>${table(["School", "Type", "Administrator", "Status", "Action"], platformSchools.map((s) => `<tr><td>${esc(s.name)}<span class="sub">${esc(s.slug)}</span></td><td>${esc(s.school_type)}</td><td>${esc(s.administrator_name || "—")}<span class="sub">${esc(s.administrator_email || "")}</span></td><td><span class="badge ${s.status === "active" ? "" : "amber"}">${esc(s.status)}</span><span class="sub">Invitation: ${esc(s.invitation_status || "not sent")}</span></td><td>${s.status === "active" ? "—" : `<button class="text-button resend-invitation" data-id="${esc(s.id)}">Resend invitation</button>`}</td></tr>`).join(""))}</section></div>`
  );
}
async function platformApi(path, options = {}) {
  const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
        ...options.headers,
      },
    }),
    data = await response.json();
  if (!response.ok) throw Error(data.error || "Request failed");
  return data;
}
async function loadSchools() {
  try {
    platformSchools = (await platformApi("/api/platform/schools")).schools;
    if (view === "platform") render();
  } catch (err) {
    if (view === "platform") $("#platform-error").textContent = err.message;
  }
}
async function schoolApi(path, options = {}) {
  const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
        ...options.headers,
      },
    }),
    data = await response.json();
  if (!response.ok) throw Error(data.error || "Request failed");
  return data;
}
async function loadSchoolStudents() {
  const data = await schoolApi("/api/school/students");
  schoolClassIds = new Map(data.classes.map((item) => [item.name, item.id]));
  schoolSubjectIds = new Map(data.subjects.map((item) => [item.name, item.id]));
  state.settings.classes = data.classes.map((item) => item.name);
  state.settings.subjects = data.subjects.map((item) => item.name);
  if (!schoolSubjects().includes(selectedSubject))
    selectedSubject = schoolSubjects()[0];
  state.students = data.students.map((student) => ({
    id: student.id,
    admission: student.student_number,
    name: student.full_name,
    class: student.class_name || "Unassigned",
    guardianName: student.guardian_name || "",
    guardianPhone: student.guardian_phone || "",
    status: student.status || "active",
  }));
  state.attendance = {};
  state.marks = {};
  state.published = [];
  selectedClass = state.settings.classes[0];
  schoolDataLive = true;
}
async function loadSchoolFinance() {
  const data = await schoolApi("/api/school/finance");
  schoolFeeTypeIds = new Map(data.feeTypes.map((item) => [item.name, item.id]));
  state.settings.feeTypes = data.feeTypes.map((item) => item.name);
  state.charges = data.charges.map((charge) => ({
    id: charge.id,
    studentId: charge.student_id,
    label: charge.description,
    amount: Number(charge.amount_bututs),
    createdAt: charge.created_at,
  }));
  state.payments = data.payments.map((payment) => ({
    id: payment.id,
    studentId: payment.student_id,
    amount: Number(payment.amount_bututs),
    reference: payment.receipt_number,
    date: String(payment.paid_on).slice(0, 10),
  }));
}
async function loadSchoolStaff() {
  schoolStaff = (await schoolApi("/api/school/staff")).staff;
}
async function loadSchoolActivity() {
  schoolActivity = (await schoolApi("/api/school/activity")).activity;
}
async function loadSchoolAttendance(
  date = selectedDate,
  className = selectedClass,
) {
  if (!schoolDataLive || !className) return;
  const data = await schoolApi(
      `/api/school/attendance?date=${encodeURIComponent(date)}&class=${encodeURIComponent(className)}`,
    ),
    classIds = new Set(
      state.students
        .filter((student) => student.class === className)
        .map((student) => student.id),
    ),
    existing = { ...(state.attendance[date]?.marks || {}) };
  for (const studentId of classIds) delete existing[studentId];
  state.attendance[date] = {
    marks: { ...existing, ...data.marks },
    saved: data.saved,
  };
}
async function loadSchoolResults(
  className = selectedClass,
  subjectName = selectedSubject,
) {
  if (!schoolDataLive || !className) return;
  const data = await schoolApi(
    `/api/school/results?class=${encodeURIComponent(className)}&subject=${encodeURIComponent(subjectName)}&term=${encodeURIComponent(state.settings.term)}`,
  );
  const classStudentIds = new Set(
    state.students
      .filter((student) => student.class === className)
      .map((student) => student.id),
  );
  for (const studentId of classStudentIds) delete state.marks[studentId];
  state.published = state.published.filter(
    (item) =>
      !(
        item.class === className &&
        item.subject === subjectName &&
        item.term === state.settings.term
      ),
  );
  if (!data.assessment) return;
  for (const mark of data.marks)
    state.marks[mark.student_id] = Number(mark.score);
  state.published.push({
    class: className,
    subject: data.assessment.subject_name || subjectName,
    term: data.assessment.term,
    version: Number(data.assessment.version),
    pass: state.settings.pass,
    entries: data.marks.map((mark) => ({
      id: mark.student_id,
      admission: mark.student_number,
      name: mark.full_name,
      score: Number(mark.score),
    })),
  });
}
function dashboard() {
  const charges = state.charges.reduce((s, c) => s + c.amount, 0),
    paid = state.payments.reduce((s, p) => s + p.amount, 0),
    outstanding = state.students.reduce(
      (sum, s) => sum + Math.max(0, balance(state, s.id)),
      0,
    );
  const summary = attendanceSummary(
    state.attendance[selectedDate]?.marks || {},
  );
  const stats = [
    [
      "Total students",
      state.students.length,
      "Across " +
        schoolClasses().length +
        (schoolDataLive ? " classes" : " demo classes"),
      "♙",
    ],
    [
      "Recorded payments",
      money(paid),
      schoolDataLive
        ? "Recorded school transactions"
        : "Demo transactions · not actual collections",
      "◈",
    ],
    [
      "Outstanding fees",
      money(outstanding),
      "Credits are shown separately in fees",
      "↗",
    ],
    [
      "Attendance",
      summary.rate === null ? "—" : summary.rate + "%",
      summary.marked + " of " + state.students.length + " marked today",
      "✓",
    ],
  ];
  return (
    heading(
      "A clearer view of your school",
      schoolDataLive
        ? "Welcome back. Here’s your school workspace."
        : "Welcome back. Here’s your fictional school workspace.",
      `<a class="button" href="#students">＋ Add a student</a>`,
    ) +
    `<div class="cards">${stats.map(([label, n, sub, icon]) => `<div class="card"><div class="card-label">${label}<span class="stat-icon" aria-hidden="true">${icon}</span></div><div class="number">${n}</div><small>${sub}</small></div>`).join("")}</div><div class="grid"><section class="panel"><div class="panel-heading"><h2>Student overview</h2><a class="text-button" href="#students">View all students →</a></div>${table(
      ["Student", "Class", "Fee status"],
      state.students
        .slice(0, 5)
        .map(
          (s) =>
            `<tr><td>${studentCell(s)}</td><td>${esc(s.class)}</td><td>${badge(balance(state, s.id))}</td></tr>`,
        )
        .join(""),
    )}</section><section class="panel"><div class="panel-heading"><h2>Fees at a glance</h2><small>${schoolDataLive ? "Current ledger" : "Current demo ledger"}</small></div><div class="number">${money(paid)}</div><p>recorded against ${money(charges)} in charges</p><div class="bar" role="meter" aria-label="Payments relative to charges" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${charges ? Math.min(100, Math.round((paid / charges) * 100)) : 0}"><div class="bar-fill" id="fee-bar"></div></div><div class="bar-row"><div class="bar-label"><span>Total charges</span><strong>${money(charges)}</strong></div><div class="bar-label"><span>Unpaid student balances</span><strong>${money(outstanding)}</strong></div></div><div class="quick-actions"><a class="button secondary" href="#fees">Record payment</a><a class="button secondary" href="#reports">Export report</a></div><div class="note">${schoolDataLive ? "Student and financial records are securely stored in the school database." : "This prototype uses fictional records stored only in this browser."}</div></section><section class="panel wide"><div class="panel-heading"><h2>Your next tasks</h2><span class="badge gray">${esc(role)} ${schoolDataLive ? "workspace" : "demo view"}</span></div><div class="quick-actions">${(role ===
    "Teacher"
      ? [
          ["attendance", "Take class attendance"],
          ["results", "Enter draft marks"],
        ]
      : role === "Finance"
        ? [
            ["fees", "Review fee balances"],
            [
              "reports",
              schoolDataLive ? "Download ledger" : "Download demo ledger",
            ],
          ]
        : [
            ["students", "Review student register"],
            ["attendance", "Take class attendance"],
            ["results", "Prepare results"],
          ]
    )
      .map(
        ([id, label]) =>
          `<a class="button secondary" href="#${id}">${label} →</a>`,
      )
      .join(
        "",
      )}</div><p class="note">Demo view changes these shortcuts only. It does not enforce permissions.</p></section></div>`
  );
}
function students() {
  const list = state.students.filter(
      (s) =>
        (!studentClass || s.class === studentClass) &&
        (!studentStatus || (s.status || "active") === studentStatus) &&
        `${s.name} ${s.admission}`.toLowerCase().includes(search.toLowerCase()),
    ),
    editing = state.students.find((s) => s.id === editingStudentId);
  return (
    heading(
      "Students",
      "Keep a clear register of enrolment and class assignments.",
    ) +
    `<div class="stack"><section class="panel"><div class="panel-heading"><h2>${editing ? "Edit student" : schoolDataLive ? "Register a student" : "Register a fictional student"}</h2><span class="badge gray">${schoolDataLive ? "Neon record" : "Demo record"}</span></div><form id="student-form"><div class="form-grid"><div class="field"><label for="student-number">Student number</label><input id="student-number" name="studentNumber" maxlength="30" required autocomplete="off" placeholder="e.g. STU-2026-001" value="${esc(editing?.admission || "")}"></div><div class="field"><label for="name">Student full name</label><input id="name" name="name" maxlength="80" required placeholder="e.g. Awa Example" value="${esc(editing?.name || "")}"></div><div class="field"><label for="new-class">Class</label><select id="new-class" name="class">${options(schoolClasses(), editing?.class || schoolClasses()[0])}</select></div></div><div class="form-actions"><button class="button">${editing ? "Save changes" : "Add student"}</button>${editing ? '<button type="button" class="button secondary" id="cancel-edit">Cancel</button>' : ""}<span class="status-text">Each student number must be unique within this school.</span></div><div class="error" id="form-error" role="alert"></div></form></section><section class="panel" id="student-import-panel"><div class="panel-heading"><div><h2>Import students from Excel</h2><p>Download the CSV template, complete it in Excel, then upload the saved CSV file.</p></div></div><form id="student-import-form"><div class="form-grid"><div class="field"><label for="student-import-file">Completed CSV file</label><input id="student-import-file" name="file" type="file" accept=".csv,text/csv" required></div></div><div class="form-actions"><button type="button" class="button secondary" id="student-template">Download template</button><button class="button">Import students</button><span class="status-text">Maximum 1,000 students per file.</span></div><div id="student-import-error" class="error" role="alert"></div></form></section><section class="panel"><div class="panel-heading"><h2>Student register</h2><small>${list.length} students</small></div><div class="toolbar"><input id="search" type="search" aria-label="Search students" value="${esc(search)}" placeholder="Search name or student number"><select id="student-class" aria-label="Filter students by class"><option value="">All classes</option>${options(schoolClasses(), studentClass)}</select><select id="student-status" aria-label="Filter students by status"><option value="">All statuses</option>${options(["active", "inactive", "graduated"], studentStatus)}</select></div>${table(["Student", "Class", "Status", "Balance", "Action"], list.map((s) => `<tr><td>${studentCell(s)}</td><td>${esc(s.class)}</td><td><span class="badge ${(s.status || "active") === "active" ? "" : "gray"}">${esc(s.status || "active")}</span></td><td>${money(balance(state, s.id))}</td><td><button class="text-button edit-student" data-id="${s.id}">Edit</button> · <button class="text-button student-status-action" data-id="${s.id}" data-status="${(s.status || "active") === "active" ? "inactive" : "active"}">${(s.status || "active") === "active" ? "Deactivate" : "Reactivate"}</button>${(s.status || "active") === "active" ? ` · <button class="text-button student-status-action" data-id="${s.id}" data-status="graduated">Graduate</button>` : ""}</td></tr>`).join(""))}</section></div>`
  );
}
function attendance() {
  const list = activeStudents().filter((s) => s.class === selectedClass),
    record = state.attendance[selectedDate] || { marks: {}, saved: null };
  const marks = attendanceDraft || record.marks;
  const count = list.filter(
    (s) => marks[s.id] && marks[s.id] !== "unmarked",
  ).length;
  return (
    heading(
      "Attendance",
      "Record daily attendance. Unmarked is never treated as absent.",
    ) +
    `<section class="panel"><div class="toolbar"><label for="att-class">Class</label><select id="att-class">${options(schoolClasses(), selectedClass)}</select><label for="att-date">Date</label><input id="att-date" type="date" value="${selectedDate}" required><span class="badge ${count === list.length ? "" : "amber"}">${count}/${list.length} marked</span></div>${table(["Student", "Attendance"], list.map((s) => `<tr><td>${studentCell(s)}</td><td><select class="attendance-select" data-student="${s.id}" aria-label="Attendance for ${esc(s.name)}">${options(["unmarked", "present", "late", "absent", "excused"], marks[s.id] || "unmarked")}</select></td></tr>`).join(""))}<div class="form-actions"><button class="button" id="save-attendance">Save attendance</button><button class="button secondary" id="present-all">Mark class present</button><button class="button secondary" id="print-attendance">Print report</button><button class="button secondary" id="attendance-csv">Download CSV</button><span class="status-text" id="attendance-status">${attendanceDraft ? "Unsaved changes" : record.saved ? `${schoolDataLive ? "Saved to Neon" : "Saved in browser"} · ${count === list.length ? "class complete" : "class incomplete"}` : "Not saved yet"}</span></div><div class="note">Attendance rate = present + late divided by present + late + absent. Excused and unmarked are excluded. Save changes before printing or downloading.</div></section>`
  );
}
function attendanceReportData() {
  const marks = state.attendance[selectedDate]?.marks || {},
    students = activeStudents()
      .filter((student) => student.class === selectedClass)
      .map((student) => ({
        ...student,
        attendanceStatus: marks[student.id] || "unmarked",
      })),
    summary = attendanceSummary(marks);
  for (const status of ["present", "late", "absent", "excused"])
    summary[status] = students.filter(
      (student) => student.attendanceStatus === status,
    ).length;
  return { students, summary };
}
function printAttendanceReport() {
  if (attendanceDraft) {
    toast("Save the attendance changes before printing.");
    return;
  }
  const { students, summary } = attendanceReportData(),
    popup = window.open("", "_blank");
  if (!popup) {
    toast("Allow pop-ups to open the printable attendance report.");
    return;
  }
  popup.document.write(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Attendance ${esc(selectedDate)}</title><style>@page{size:A4 portrait;margin:14mm}body{font:12px Arial;color:#203330;margin:0;padding:16px}header{border-bottom:3px solid #146a56;padding-bottom:12px;margin-bottom:20px}h1{margin:0 0 6px}.summary{display:flex;gap:18px;flex-wrap:wrap;margin:14px 0}.summary span{padding:7px 10px;background:#edf5ef;border-radius:5px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #dce6e1;text-align:left}th{background:#eaf4ef}button{margin:18px 0;padding:10px 15px;background:#146a56;color:#fff;border:0;border-radius:6px}@media print{button{display:none}body{padding:0}}</style></head><body><header><h1>${esc(state.settings.name)}</h1><div>Attendance report · ${esc(selectedClass)} · ${esc(selectedDate)}</div></header><div class="summary"><span>Present: ${summary.present}</span><span>Late: ${summary.late}</span><span>Absent: ${summary.absent}</span><span>Excused: ${summary.excused}</span><span>Attendance rate: ${summary.rate === null ? "—" : summary.rate + "%"}</span></div><table><thead><tr><th>Student number</th><th>Student name</th><th>Status</th></tr></thead><tbody>${students.map((student) => `<tr><td>${esc(student.admission)}</td><td>${esc(student.name)}</td><td>${esc(student.attendanceStatus)}</td></tr>`).join("") || '<tr><td colspan="3">No active students in this class.</td></tr>'}</tbody></table><button onclick="window.print()">Print or save as PDF</button></body></html>`,
  );
  popup.document.close();
}
function downloadAttendanceCsv() {
  if (attendanceDraft) {
    toast("Save the attendance changes before downloading.");
    return;
  }
  const { students } = attendanceReportData(),
    content = csv([
      ["Date", "Class", "Student number", "Student name", "Status"],
      ...students.map((student) => [
        selectedDate,
        selectedClass,
        student.admission,
        student.name,
        student.attendanceStatus,
      ]),
    ]),
    blob = new Blob(["\ufeff" + content], { type: "text/csv;charset=utf-8" }),
    url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${selectedClass.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${selectedDate}-attendance.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Attendance CSV downloaded.");
}
function fees() {
  return (
    heading(
      "Fees & payments",
      schoolDataLive
        ? "Review charges, record receipts and see outstanding balances."
        : "Review charges, record demo receipts and see outstanding balances.",
    ) +
    `<div class="grid"><section class="panel"><div class="panel-heading"><h2>Record ${schoolDataLive ? "a" : "a demo"} payment</h2></div><form id="payment-form"><div class="field"><label for="pay-student">Student</label><select id="pay-student" name="student">${state.students.map((s) => `<option value="${s.id}">${esc(s.name)} · ${esc(s.admission)}</option>`).join("")}</select></div><div class="field"><label for="amount">Amount in dalasi</label><input id="amount" name="amount" type="text" inputmode="decimal" required placeholder="1500.00"></div><div class="note">Overpayment becomes a displayed credit, not an automatic refund.</div><div class="form-actions"><button class="button">Record payment</button></div><div id="form-error" class="error" role="alert"></div><div id="receipt" role="status"></div></form></section><section class="panel"><div class="panel-heading"><h2>Add ${schoolDataLive ? "a" : "a demo"} charge</h2></div><form id="charge-form"><div class="field"><label for="charge-student">Student</label><select id="charge-student" name="student">${state.students.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></div><div class="field"><label for="charge-label">Fee type</label><select id="charge-label" name="label">${options(state.settings.feeTypes, state.settings.feeTypes[0])}</select></div><div class="field"><label for="charge-amount">Amount in dalasi</label><input id="charge-amount" name="amount" inputmode="decimal" required placeholder="1500.00"></div><div class="form-actions"><button class="button secondary">Add charge</button></div><div id="charge-error" class="error" role="alert"></div></form></section><section class="panel wide"><div class="panel-heading"><div><h2>Charge an entire class</h2><p>Apply the same fee to every active student in a class.</p></div></div><form id="class-charge-form"><div class="form-grid"><div class="field"><label for="class-charge-class">Class</label><select id="class-charge-class" name="className">${options(schoolClasses(), schoolClasses()[0])}</select></div><div class="field"><label for="class-charge-label">Fee type</label><select id="class-charge-label" name="label">${options(state.settings.feeTypes, state.settings.feeTypes[0])}</select></div><div class="field"><label for="class-charge-amount">Amount per student in dalasi</label><input id="class-charge-amount" name="amount" inputmode="decimal" required placeholder="1500.00"></div></div><div class="form-actions"><button class="button secondary">Apply class charge</button><span class="status-text">Only active students will be charged.</span></div><div id="class-charge-error" class="error" role="alert"></div></form></section><section class="panel wide"><div class="panel-heading"><h2>Student balances</h2><small>Negative balance = credit</small></div>${table(["Student", "Class", "Balance", "Status", "Action"], state.students.map((s) => `<tr><td>${studentCell(s)}</td><td>${esc(s.class)}</td><td>${money(balance(state, s.id))}</td><td>${badge(balance(state, s.id))}</td><td><button class="text-button print-statement" data-id="${esc(s.id)}">Print statement</button>${balance(state, s.id) > 0 && s.guardianPhone ? ` · <button class="text-button whatsapp-reminder" data-id="${esc(s.id)}">WhatsApp reminder</button>` : ""}</td></tr>`).join(""))}</section><section class="panel wide"><div class="panel-heading"><h2>Recent ${schoolDataLive ? "" : "demo "}receipts</h2></div>${table(
      ["Receipt", "Student", "Date", "Amount", "Action"],
      state.payments
        .slice()
        .reverse()
        .slice(0, 10)
        .map(
          (p) =>
            `<tr><td>${esc(p.reference)}</td><td>${esc(state.students.find((s) => s.id === p.studentId)?.name)}</td><td>${esc(p.date)}</td><td>${money(p.amount)}</td><td><button class="text-button print-receipt" data-id="${esc(p.id)}">Print receipt</button></td></tr>`,
        )
        .join(""),
    )}</section><section class="panel wide"><div class="panel-heading"><div><h2>Payment Status Report</h2><p>Print students with outstanding payments separately from students who are fully paid.</p></div><span class="badge gray">${esc(state.settings.term)}</span></div><div class="quick-actions"><button class="button" id="outstanding-print">Print outstanding students</button><button class="button secondary" id="paid-print">Print fully-paid students</button><button class="button secondary" id="payment-print">Print complete report</button><button class="button secondary" id="payment-excel">Download Excel</button></div><div class="note">Each report includes student name, student number, class, charges, amount paid and balance.</div></section></div>`
  );
}
function printReceipt(paymentId) {
  const payment = state.payments.find((item) => item.id === paymentId),
    student =
      payment && state.students.find((item) => item.id === payment.studentId);
  if (!payment || !student) {
    toast("Receipt record could not be found.");
    return;
  }
  const popup = window.open("", "_blank");
  if (!popup) {
    toast("Allow pop-ups to open the printable receipt.");
    return;
  }
  popup.document.write(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(payment.reference)}</title><style>@page{size:A5 portrait;margin:14mm}body{font:14px Arial;color:#203330;margin:0;padding:24px}.receipt{max-width:620px;margin:auto;border:1px solid #dce6e1;border-radius:12px;padding:30px}header{border-bottom:3px solid #146a56;padding-bottom:16px;margin-bottom:22px}h1{margin:0 0 6px;font-size:24px}.brand{color:#146a56;font-weight:bold}.row{display:flex;justify-content:space-between;gap:20px;padding:10px 0;border-bottom:1px solid #edf1ef}.amount{font-size:26px;font-weight:bold;color:#146a56}.foot{margin-top:24px;color:#60736d;font-size:11px;line-height:1.5}button{margin-top:20px;padding:10px 15px;background:#146a56;color:white;border:0;border-radius:6px}@media print{button{display:none}body{padding:0}.receipt{border:0}}</style></head><body><div class="receipt"><header><div class="brand">${esc(state.settings.name)}</div><h1>Payment receipt</h1><div>${esc(state.settings.term)}</div></header><div class="row"><span>Receipt number</span><strong>${esc(payment.reference)}</strong></div><div class="row"><span>Date</span><strong>${esc(payment.date)}</strong></div><div class="row"><span>Student</span><strong>${esc(student.name)}</strong></div><div class="row"><span>Student number</span><strong>${esc(student.admission)}</strong></div><div class="row"><span>Class</span><strong>${esc(student.class)}</strong></div><div class="row"><span>Amount received</span><strong class="amount">${money(payment.amount)}</strong></div><div class="row"><span>Current balance</span><strong>${money(balance(state, student.id))}</strong></div><p class="foot">Generated by the School Management Portal by Elegant Empire AI. Keep this receipt for the school’s and payer’s records.</p><button onclick="window.print()">Print or save as PDF</button></div></body></html>`,
  );
  popup.document.close();
}
function printStudentStatement(studentId) {
  const student = state.students.find((item) => item.id === studentId);
  if (!student) {
    toast("Student record could not be found.");
    return;
  }
  const charges = state.charges.filter((item) => item.studentId === studentId),
    payments = state.payments.filter((item) => item.studentId === studentId),
    totalCharges = charges.reduce((sum, item) => sum + item.amount, 0),
    totalPayments = payments.reduce((sum, item) => sum + item.amount, 0),
    currentBalance = totalCharges - totalPayments,
    popup = window.open("", "_blank");
  if (!popup) {
    toast("Allow pop-ups to open the printable statement.");
    return;
  }
  const rows = [
    ...charges.map((item) => ({
      date: item.createdAt ? String(item.createdAt).slice(0, 10) : "—",
      type: "Charge",
      reference: item.label,
      charge: item.amount,
      payment: 0,
    })),
    ...payments.map((item) => ({
      date: item.date || "—",
      type: "Payment",
      reference: item.reference,
      charge: 0,
      payment: item.amount,
    })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  popup.document.write(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(student.admission)} Fee Statement</title><style>@page{size:A4 portrait;margin:14mm}body{font:12px Arial;color:#203330;margin:0;padding:16px}header{border-bottom:3px solid #146a56;padding-bottom:12px;margin-bottom:20px}h1{margin:0 0 6px}.details{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-bottom:20px}.summary{display:flex;gap:14px;flex-wrap:wrap;margin:16px 0}.summary span{padding:8px 11px;background:#edf5ef;border-radius:5px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #dce6e1;text-align:left}th{background:#eaf4ef}td:nth-child(n+4),th:nth-child(n+4){text-align:right}.balance{font-weight:bold;color:${currentBalance > 0 ? "#956f22" : "#146a56"}}button{margin:18px 0;padding:10px 15px;background:#146a56;color:#fff;border:0;border-radius:6px}@media(max-width:600px){.details{grid-template-columns:1fr}body{overflow-x:auto}table{min-width:650px}}@media print{button{display:none}body{padding:0}}</style></head><body><header><h1>${esc(state.settings.name)}</h1><div>Student fee statement · ${esc(state.settings.term)}</div></header><div class="details"><div><strong>Student:</strong> ${esc(student.name)}</div><div><strong>Student number:</strong> ${esc(student.admission)}</div><div><strong>Class:</strong> ${esc(student.class)}</div><div><strong>Status:</strong> ${esc(student.status || "active")}</div><div><strong>Guardian:</strong> ${esc(student.guardianName || "—")}</div><div><strong>Guardian phone:</strong> ${esc(student.guardianPhone || "—")}</div></div><div class="summary"><span>Total charges: ${money(totalCharges)}</span><span>Total paid: ${money(totalPayments)}</span><span class="balance">${currentBalance > 0 ? "Outstanding" : currentBalance < 0 ? "Credit" : "Balance"}: ${money(Math.abs(currentBalance))}</span></div><table><thead><tr><th>Date</th><th>Type</th><th>Description or receipt</th><th>Charge</th><th>Payment</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.date)}</td><td>${esc(row.type)}</td><td>${esc(row.reference)}</td><td>${row.charge ? money(row.charge) : "—"}</td><td>${row.payment ? money(row.payment) : "—"}</td></tr>`).join("") || '<tr><td colspan="5">No financial transactions recorded.</td></tr>'}</tbody><tfoot><tr><th colspan="3">Totals</th><th>${money(totalCharges)}</th><th>${money(totalPayments)}</th></tr></tfoot></table><button onclick="window.print()">Print or save as PDF</button></body></html>`,
  );
  popup.document.close();
}
function openWhatsAppReminder(studentId) {
  const student = state.students.find((item) => item.id === studentId),
    outstanding = student ? balance(state, student.id) : 0;
  if (!student || !student.guardianPhone || outstanding <= 0) {
    toast("Add a guardian phone number and an outstanding balance first.");
    return;
  }
  let phone = student.guardianPhone.replace(/\D/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.length === 7) phone = "220" + phone;
  if (phone.length < 10) {
    toast("Check the guardian phone number and include the country code.");
    return;
  }
  const guardian = student.guardianName ? ` ${student.guardianName}` : "",
    message = `Hello${guardian}, this is a fee reminder from ${state.settings.name}. ${student.name} (${student.admission}) has an outstanding school balance of ${money(outstanding)} for ${state.settings.term}. Please contact the school if you need any clarification. Thank you.`;
  window.open(
    `https://wa.me/${encodeURIComponent(phone)}?text=${encodeURIComponent(message)}`,
    "_blank",
    "noopener,noreferrer",
  );
}
function results() {
  const list = activeStudents().filter((s) => s.class === selectedClass),
    snap = state.published
      .filter(
        (p) =>
          p.class === selectedClass &&
          (p.subject || "General") === selectedSubject &&
          p.term === state.settings.term,
      )
      .at(-1);
  return (
    heading(
      "Results",
      schoolDataLive
        ? "Prepare an assessment, then publish a versioned snapshot."
        : "Prepare a single demo assessment, then publish a versioned snapshot.",
      '<button class="button secondary" id="print-report-cards">Print class report cards</button>',
    ) +
    `<section class="panel"><div class="toolbar"><label for="res-class">Class</label><select id="res-class">${options(schoolClasses(), selectedClass)}</select><label for="res-subject">Subject</label><select id="res-subject">${options(schoolSubjects(), selectedSubject)}</select><span class="badge gray">Draft assessment · /100</span><span class="status-text">Pass threshold: ${state.settings.pass}</span></div>${table(["Student", "Draft mark /100"], list.map((s) => `<tr><td>${studentCell(s)}</td><td><input class="money-input mark-input" type="number" min="0" max="100" step="0.01" data-student="${s.id}" aria-label="Mark for ${esc(s.name)}" value="${state.marks[s.id] ?? ""}"></td></tr>`).join(""))}<div class="form-actions"><button class="button" id="publish">Approve & publish ${schoolDataLive ? "results" : "demo results"}</button><span class="status-text">${schoolDataLive ? "Draft marks are stored securely in Neon." : "Draft marks save on change in this browser."}</span></div><div class="error" id="form-error" role="alert"></div><div class="note">Published results are versioned by class, subject and term, and do not change when draft marks are edited.</div></section>${snap ? `<section class="panel"><div class="panel-heading"><div><h2>${esc(snap.subject || "General")} · published version ${snap.version}</h2><small>${esc(snap.term)}</small></div><div class="quick-actions"><button class="button secondary" id="print-results">Print report</button><button class="button secondary" id="results-csv">Download CSV</button></div></div>${table(["Student", "Published score", "Outcome"], snap.entries.map((e) => `<tr><td>${esc(e.name)}</td><td>${e.score}</td><td><span class="badge ${e.score >= snap.pass ? "" : "amber"}">${e.score >= snap.pass ? "Pass" : "Below threshold"}</span></td></tr>`).join(""))}</section>` : ""}`
  );
}
async function printClassReportCards() {
  const popup = window.open("", "_blank");
  if (!popup) {
    toast("Allow pop-ups to open the printable report cards.");
    return;
  }
  popup.document.write(
    "<p style='font-family:Arial;padding:24px'>Preparing report cards…</p>",
  );
  try {
    let students, publishedResults;
    if (schoolDataLive) {
      const data = await schoolApi(
        `/api/school/report-cards?class=${encodeURIComponent(selectedClass)}&term=${encodeURIComponent(state.settings.term)}`,
      );
      students = data.students.map((student) => ({
        id: student.id,
        admission: student.student_number,
        name: student.full_name,
      }));
      publishedResults = data.results.map((result) => ({
        studentId: result.student_id,
        subject: result.subject_name,
        score: Number(result.score),
        maximum: Number(result.maximum_score),
      }));
    } else {
      students = activeStudents()
        .filter((student) => student.class === selectedClass)
        .map((student) => ({
          id: student.id,
          admission: student.admission,
          name: student.name,
        }));
      const latest = new Map();
      state.published
        .filter(
          (item) =>
            item.class === selectedClass && item.term === state.settings.term,
        )
        .forEach((item) => latest.set(item.subject || "General", item));
      publishedResults = [...latest.values()].flatMap((snapshot) =>
        snapshot.entries.map((entry) => ({
          studentId: entry.studentId || entry.id,
          subject: snapshot.subject || "General",
          score: Number(entry.score),
          maximum: 100,
        })),
      );
    }
    if (!publishedResults.length)
      throw Error("Publish at least one subject before printing report cards.");
    const cards = students
      .map((student) => {
        const marks = publishedResults.filter(
            (result) => result.studentId === student.id,
          ),
          average = marks.length
            ? marks.reduce(
                (sum, mark) => sum + (mark.score / mark.maximum) * 100,
                0,
              ) / marks.length
            : 0,
          passed = marks.filter(
            (mark) => (mark.score / mark.maximum) * 100 >= state.settings.pass,
          ).length;
        return `<section class="report-card"><header><h1>${esc(state.settings.name)}</h1><div>Student Report Card · ${esc(state.settings.term)}</div></header><div class="details"><div><strong>Student:</strong> ${esc(student.name)}</div><div><strong>Student number:</strong> ${esc(student.admission)}</div><div><strong>Class:</strong> ${esc(selectedClass)}</div><div><strong>Subjects published:</strong> ${marks.length}</div></div><table><thead><tr><th>Subject</th><th>Score</th><th>Outcome</th></tr></thead><tbody>${marks
          .map((mark) => {
            const percentage = (mark.score / mark.maximum) * 100;
            return `<tr><td>${esc(mark.subject)}</td><td>${mark.score} / ${mark.maximum}</td><td>${percentage >= state.settings.pass ? "Pass" : "Below threshold"}</td></tr>`;
          })
          .join(
            "",
          )}</tbody></table><div class="summary"><span>Average: <strong>${average.toFixed(1)}%</strong></span><span>Subjects passed: <strong>${passed} of ${marks.length}</strong></span><span>Overall: <strong>${marks.length && average >= state.settings.pass ? "Pass" : "Below threshold"}</strong></span></div><div class="signatures"><span>Class teacher</span><span>Head teacher</span></div></section>`;
      })
      .join("");
    popup.document.open();
    popup.document.write(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(selectedClass)} Report Cards</title><style>@page{size:A4 portrait;margin:14mm}body{font:12px Arial;color:#203330;margin:0}.report-card{min-height:250mm;page-break-after:always;box-sizing:border-box;padding:10px}.report-card:last-of-type{page-break-after:auto}header{border-bottom:3px solid #146a56;padding-bottom:12px;margin-bottom:20px}h1{margin:0 0 6px}.details{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin-bottom:20px}table{width:100%;border-collapse:collapse}th,td{padding:9px;border:1px solid #dce6e1;text-align:left}th{background:#eaf4ef}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.summary span{padding:8px 11px;background:#edf5ef;border-radius:5px}.signatures{display:flex;justify-content:space-between;margin-top:55px}.signatures span{width:38%;border-top:1px solid #61706c;padding-top:7px;text-align:center}.print{position:fixed;right:18px;top:18px;padding:10px 15px;background:#146a56;color:#fff;border:0;border-radius:6px}@media(max-width:600px){.details{grid-template-columns:1fr}.report-card{overflow-x:auto}table{min-width:480px}}@media print{.print{display:none}.report-card{padding:0}}</style></head><body><button class="print" onclick="window.print()">Print or save as PDF</button>${cards}</body></html>`,
    );
    popup.document.close();
  } catch (error) {
    popup.close();
    toast(error.message);
  }
}
function currentPublishedResult() {
  return state.published
    .filter(
      (item) =>
        item.class === selectedClass &&
        (item.subject || "General") === selectedSubject &&
        item.term === state.settings.term,
    )
    .at(-1);
}
function printResultsReport() {
  const result = currentPublishedResult();
  if (!result) {
    toast("Publish the class results before printing.");
    return;
  }
  const popup = window.open("", "_blank"),
    passed = result.entries.filter(
      (entry) => entry.score >= result.pass,
    ).length,
    average = result.entries.length
      ? result.entries.reduce((sum, entry) => sum + entry.score, 0) /
        result.entries.length
      : 0;
  if (!popup) {
    toast("Allow pop-ups to open the printable results report.");
    return;
  }
  popup.document.write(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Results ${esc(selectedClass)}</title><style>@page{size:A4 portrait;margin:14mm}body{font:12px Arial;color:#203330;margin:0;padding:16px}header{border-bottom:3px solid #146a56;padding-bottom:12px;margin-bottom:20px}h1{margin:0 0 6px}.summary{display:flex;gap:18px;flex-wrap:wrap;margin:14px 0}.summary span{padding:7px 10px;background:#edf5ef;border-radius:5px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #dce6e1;text-align:left}th{background:#eaf4ef}button{margin:18px 0;padding:10px 15px;background:#146a56;color:#fff;border:0;border-radius:6px}@media print{button{display:none}body{padding:0}}</style></head><body><header><h1>${esc(state.settings.name)}</h1><div>Published results · ${esc(selectedClass)} · ${esc(result.subject || "General")} · ${esc(result.term)} · Version ${result.version}</div></header><div class="summary"><span>Students: ${result.entries.length}</span><span>Class average: ${average.toFixed(1)}%</span><span>Passed: ${passed}</span><span>Below threshold: ${result.entries.length - passed}</span><span>Pass mark: ${result.pass}%</span></div><table><thead><tr><th>Student number</th><th>Student name</th><th>Score /100</th><th>Outcome</th></tr></thead><tbody>${result.entries.map((entry) => `<tr><td>${esc(entry.admission)}</td><td>${esc(entry.name)}</td><td>${esc(entry.score)}</td><td>${entry.score >= result.pass ? "Pass" : "Below threshold"}</td></tr>`).join("")}</tbody></table><button onclick="window.print()">Print or save as PDF</button></body></html>`,
  );
  popup.document.close();
}
function downloadResultsCsv() {
  const result = currentPublishedResult();
  if (!result) {
    toast("Publish the class results before downloading.");
    return;
  }
  const content = csv([
      [
        "Student number",
        "Student name",
        "Class",
        "Subject",
        "Term",
        "Version",
        "Score /100",
        "Pass mark",
        "Outcome",
      ],
      ...result.entries.map((entry) => [
        entry.admission,
        entry.name,
        result.class,
        result.subject || "General",
        result.term,
        result.version,
        entry.score,
        result.pass,
        entry.score >= result.pass ? "Pass" : "Below threshold",
      ]),
    ]),
    blob = new Blob(["\ufeff" + content], { type: "text/csv;charset=utf-8" }),
    url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${selectedClass.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${(result.subject || "general").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${result.term.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-results.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Published results CSV downloaded.");
}
function reports() {
  return (
    heading(
      "Reports",
      schoolDataLive
        ? "Download school records for review and administration."
        : "Download fictional records for review—not official school documents.",
    ) +
    `<div class="stack"><section class="panel"><div class="panel-heading"><div><h2>Payment status report</h2><p>Separate students with outstanding balances from students who are fully paid.</p></div><span class="badge gray">${esc(state.settings.term)}</span></div><div class="quick-actions"><button class="button" id="payment-excel">Download Excel</button><button class="button secondary" id="payment-print">Print or save as PDF</button></div><div class="note">Credit balances are included with fully paid students and clearly marked as credit.</div></section><section class="panel">${[
      [
        "students",
        "Student register",
        "Student numbers, names and class assignments.",
      ],
      [
        "fees",
        "Fee ledger",
        `${schoolDataLive ? "Individual" : "Individual demo"} charges and receipts with signed amounts.`,
      ],
      [
        "results",
        "Published results",
        "Latest published version per class for the current term. Draft marks excluded.",
      ],
    ]
      .map(
        ([id, title, description]) =>
          `<div class="report-card"><div><h3>${title}</h3><p>${description}</p></div><button class="button secondary export" data-report="${id}">Download CSV</button></div>`,
      )
      .join(
        "",
      )}<div class="note">${schoolDataLive ? "Exports contain the current school records stored in Neon." : "Exports contain this browser’s fictional demonstration records."}</div></section></div>`
  );
}
function activityDescription(item) {
  const details = item.details || {};
  return (
    {
      "student.created": `Registered ${details.fullName || "a student"} (${details.studentNumber || ""})`,
      "student.updated": `Updated ${details.fullName || "a student"}`,
      "student.status_changed": `Changed student status to ${details.status || "unknown"}`,
      "students.imported": `Imported ${details.count || 0} students`,
      "payment.recorded": `Recorded payment ${details.receiptNumber || ""} for ${money(Number(details.amountBututs || 0))}`,
      "charge.created": `Added ${details.description || "fee"} charge of ${money(Number(details.amountBututs || 0))}`,
      "class_charge.created": `Charged ${details.students || 0} students in ${details.className || "a class"}`,
      "attendance.saved": `Saved attendance for ${details.className || "a class"} on ${details.date || ""}`,
      "results.published": `Published ${details.className || "class"} results, version ${details.version || ""}`,
      "settings.updated": `Updated school settings for ${details.term || "the current term"}`,
    }[item.action] || item.action.replaceAll(".", " ")
  );
}
function activity() {
  return (
    heading(
      "Activity log",
      "Review important changes made in this school workspace.",
      '<button class="button secondary" id="refresh-activity">Refresh</button>',
    ) +
    `<section class="panel"><div class="panel-heading"><h2>Recent activity</h2><small>Latest ${schoolActivity.length} events</small></div>${table(["Date and time", "User", "Activity"], schoolActivity.map((item) => `<tr><td>${esc(new Date(item.created_at).toLocaleString("en-GB"))}</td><td>${esc(item.actor_email || "School user")}</td><td>${esc(activityDescription(item))}</td></tr>`).join(""))}<div class="note">The activity log records new actions from the time this feature is deployed. It does not recreate actions performed earlier.</div></section>`
  );
}
function staff() {
  return (
    heading(
      "Staff management",
      "Invite teachers and finance staff to this school workspace.",
    ) +
    `<div class="stack"><section class="panel"><div class="panel-heading"><h2>Invite a staff member</h2><span class="badge gray">Administrator only</span></div><form id="staff-form"><div class="form-grid"><div class="field"><label for="staff-name">Full name</label><input id="staff-name" name="fullName" maxlength="100" required></div><div class="field"><label for="staff-email">Email address</label><input id="staff-email" name="email" type="email" required></div><div class="field"><label for="staff-role">Role</label><select id="staff-role" name="role"><option value="teacher">Teacher</option><option value="finance">Finance</option></select></div></div><div class="form-actions"><button class="button">Send invitation</button><span class="status-text">Personal email addresses can be used.</span></div><div id="staff-error" class="error" role="alert"></div></form></section><section class="panel"><div class="panel-heading"><h2>Staff access</h2><small>${schoolStaff.length} staff</small></div>${table(["Staff member", "Role", "Status", "Invited", "Actions"], schoolStaff.map((member) => `<tr><td><span class="student-name">${esc(member.full_name)}</span><span class="sub">${esc(member.email)}</span></td><td><select class="staff-role-select" data-id="${esc(member.id)}" aria-label="Role for ${esc(member.full_name)}"><option value="teacher" ${member.role === "teacher" ? "selected" : ""}>Teacher</option><option value="finance" ${member.role === "finance" ? "selected" : ""}>Finance</option></select></td><td><span class="badge ${member.invitation_status === "accepted" ? "" : "amber"}">${esc(member.invitation_status)}</span></td><td>${esc(new Date(member.invited_at).toLocaleDateString("en-GB"))}</td><td><div class="quick-actions">${member.invitation_status !== "accepted" ? `<button class="text-button resend-staff" data-id="${esc(member.id)}">Resend</button>` : ""}<button class="text-button revoke-staff" data-id="${esc(member.id)}" data-name="${esc(member.full_name)}">${member.invitation_status === "accepted" ? "Deactivate" : "Cancel"}</button></div></td></tr>`).join(""))}</section></div>`
  );
}
function settings() {
  return (
    heading(
      "School settings",
      schoolDataLive
        ? "Manage the school details, classes and fee types."
        : "Manage the school details, classes and fee types used in this demo.",
    ) +
    `<div class="stack"><section class="panel"><form id="settings-form"><div class="form-grid"><div class="field"><label for="school">School display name</label><input name="school" id="school" value="${esc(state.settings.name)}" maxlength="80" required></div><div class="field"><label for="term-label">Term label</label><input name="term" id="term-label" value="${esc(state.settings.term)}" maxlength="60" required></div><div class="field"><label for="pass">Demo pass threshold /100</label><input name="pass" id="pass" type="number" min="0" max="100" step="1" required value="${state.settings.pass}"></div></div><div class="form-actions"><button class="button">Save settings</button></div><div class="error" id="form-error" role="alert"></div></form></section><section class="panel"><div class="panel-heading"><h2>Classes and grade levels</h2><small>${schoolClasses().length} configured</small></div><form id="class-form" class="toolbar"><input name="className" maxlength="60" required placeholder="e.g. Grade 10 · A" aria-label="New class name"><button class="button">Add class</button></form><div class="error" id="class-error" role="alert"></div>${table(
      ["Class", "Students", "Action"],
      schoolClasses()
        .map((name) => {
          const count = state.students.filter((s) => s.class === name).length;
          return `<tr><td>${esc(name)}</td><td>${count}</td><td><button class="text-button remove-class" data-name="${esc(name)}" ${count || schoolClasses().length === 1 ? "disabled" : ""}>Remove</button></td></tr>`;
        })
        .join(""),
    )}<div class="note">A class cannot be removed while students are assigned to it.</div></section><section class="panel"><div class="panel-heading"><h2>Fee types</h2><small>${state.settings.feeTypes.length} configured</small></div><form id="fee-type-form" class="toolbar"><input name="feeType" maxlength="60" required placeholder="e.g. Transport fee" aria-label="New fee type"><button class="button">Add fee type</button></form><div class="error" id="fee-type-error" role="alert"></div>${table(
      ["Fee type", "Used charges", "Action"],
      state.settings.feeTypes
        .map((name) => {
          const count = state.charges.filter((c) => c.label === name).length;
          return `<tr><td>${esc(name)}</td><td>${count}</td><td><button class="text-button remove-fee-type" data-name="${esc(name)}" ${count || state.settings.feeTypes.length === 1 ? "disabled" : ""}>Remove</button></td></tr>`;
        })
        .join(""),
    )}<div class="note">A fee type cannot be removed after it has been used for a charge.</div></section><section class="panel"><div class="panel-heading"><h2>School subjects</h2><small>${state.settings.subjects.length} configured</small></div><form id="subject-form" class="toolbar"><input name="subjectName" maxlength="80" required placeholder="e.g. Mathematics" aria-label="New subject name"><button class="button">Add subject</button></form><div id="subject-error" class="error" role="alert"></div>${table(["Subject", "Action"], state.settings.subjects.map((name) => `<tr><td>${esc(name)}</td><td><button class="text-button remove-subject" data-name="${esc(name)}">Remove</button></td></tr>`).join(""))}<div class="note">Subjects will be used for assessments and student report cards.</div></section><div class="note">Published results retain their original term and threshold. ${schoolDataLive ? "These settings are stored securely in Neon." : "These prototype settings are stored only in this browser."}</div></div>`
  );
}
function wire() {
  document.querySelectorAll("[data-nav]").forEach(
    (a) =>
      (a.onclick = (e) => {
        e.preventDefault();
        navigate(a.dataset.nav);
      }),
  );
  if (view === "dashboard") {
    const charges = state.charges.reduce((s, c) => s + c.amount, 0),
      paid = state.payments.reduce((s, p) => s + p.amount, 0);
    $("#fee-bar").style.width =
      (charges ? Math.min(100, (paid / charges) * 100) : 0) + "%";
  }
  if (view === "platform") {
    $("#refresh-schools").onclick = loadSchools;
    $("#school-onboarding-form").onsubmit = async (e) => {
      e.preventDefault();
      const button = e.target.querySelector(".button"),
        data = Object.fromEntries(new FormData(e.target));
      button.disabled = true;
      try {
        const result = await platformApi("/api/platform/schools", {
          method: "POST",
          body: JSON.stringify(data),
        });
        e.target.reset();
        toast(result.warning || "School created and invitation email sent.");
        await loadSchools();
      } catch (err) {
        $("#platform-error").textContent = err.message;
      } finally {
        button.disabled = false;
      }
    };
    document.querySelectorAll(".resend-invitation").forEach(
      (button) =>
        (button.onclick = async () => {
          button.disabled = true;
          try {
            await platformApi(
              `/api/platform/schools/${button.dataset.id}/resend-invitation`,
              { method: "POST" },
            );
            toast("A new invitation email was sent.");
            await loadSchools();
          } catch (err) {
            $("#platform-error").textContent = err.message;
          } finally {
            button.disabled = false;
          }
        }),
    );
  }
  if (view === "students") {
    $("#student-form .form-grid").insertAdjacentHTML(
      "beforeend",
      `<div class="field"><label for="guardian-name">Parent or guardian name</label><input id="guardian-name" name="guardianName" maxlength="100" value="${esc(state.students.find((student) => student.id === editingStudentId)?.guardianName || "")}" placeholder="Optional"></div><div class="field"><label for="guardian-phone">Parent or guardian phone</label><input id="guardian-phone" name="guardianPhone" type="tel" maxlength="40" value="${esc(state.students.find((student) => student.id === editingStudentId)?.guardianPhone || "")}" placeholder="Optional"></div>`,
    );
    $("#student-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target),
        name = f.get("name").trim(),
        studentNumber = f.get("studentNumber").trim().toUpperCase();
      if (!studentNumber) {
        $("#form-error").textContent = "Enter a student number.";
        return;
      }
      if (!/^[A-Z0-9][A-Z0-9\-/]{1,29}$/.test(studentNumber)) {
        $("#form-error").textContent =
          "Use 2–30 letters, numbers, hyphens or slashes for the student number.";
        return;
      }
      if (
        state.students.some(
          (s) =>
            s.id !== editingStudentId &&
            s.admission.toUpperCase() === studentNumber,
        )
      ) {
        $("#form-error").textContent = "That student number is already in use.";
        return;
      }
      if (!name) {
        $("#form-error").textContent = "Enter the student’s full name.";
        return;
      }
      const editing = state.students.find((s) => s.id === editingStudentId);
      if (schoolDataLive) {
        const button = e.target.querySelector(".button");
        button.disabled = true;
        try {
          await schoolApi(
            editing
              ? `/api/school/students/${editing.id}`
              : "/api/school/students",
            {
              method: editing ? "PATCH" : "POST",
              body: JSON.stringify({
                studentNumber,
                fullName: name,
                className: f.get("class"),
                guardianName: f.get("guardianName"),
                guardianPhone: f.get("guardianPhone"),
              }),
            },
          );
          editingStudentId = null;
          await loadSchoolStudents();
          await loadSchoolFinance();
          render();
          toast(
            editing ? "Student details updated." : "Student saved to Neon.",
          );
        } catch (err) {
          $("#form-error").textContent = err.message;
          button.disabled = false;
        }
        return;
      }
      if (editing) {
        editing.admission = studentNumber;
        editing.name = name;
        editing.class = f.get("class");
        editing.guardianName = f.get("guardianName");
        editing.guardianPhone = f.get("guardianPhone");
        editingStudentId = null;
      } else
        state.students.push({
          id: crypto.randomUUID(),
          admission: studentNumber,
          name,
          class: f.get("class"),
          guardianName: f.get("guardianName"),
          guardianPhone: f.get("guardianPhone"),
        });
      save();
      render();
      toast(
        editing
          ? "Student details updated."
          : "Fictional student added. No fee charge created automatically.",
      );
    };
    $("#student-template").onclick = downloadStudentTemplate;
    $("#student-import-form").onsubmit = async (e) => {
      e.preventDefault();
      const button = e.target.querySelector("button[type=submit]"),
        error = $("#student-import-error"),
        file = new FormData(e.target).get("file");
      error.textContent = "";
      button.disabled = true;
      try {
        const rows = parseCsvText(await file.text());
        if (rows.length < 2)
          throw Error("The CSV file does not contain student rows.");
        const headers = rows[0].map((value) =>
          value.replace(/^\ufeff/, "").toLowerCase(),
        );
        if (
          headers[0] !== "student number" ||
          headers[1] !== "full name" ||
          headers[2] !== "class"
        )
          throw Error(
            "Use the template columns: Student number, Full name, Class.",
          );
        const importedStudents = rows.slice(1).map((row) => ({
          studentNumber: row[0] || "",
          fullName: row[1] || "",
          className: row[2] || "",
          guardianName: row[3] || "",
          guardianPhone: row[4] || "",
        }));
        if (schoolDataLive) {
          const result = await schoolApi("/api/school/students/import", {
            method: "POST",
            body: JSON.stringify({ students: importedStudents }),
          });
          await loadSchoolStudents();
          await loadSchoolFinance();
          render();
          toast(`${result.imported} students imported successfully.`);
        } else {
          for (const student of importedStudents)
            state.students.push({
              id: crypto.randomUUID(),
              admission: student.studentNumber.toUpperCase(),
              name: student.fullName,
              class: student.className,
              guardianName: student.guardianName,
              guardianPhone: student.guardianPhone,
              status: "active",
            });
          save();
          render();
          toast(`${importedStudents.length} demo students imported.`);
        }
      } catch (err) {
        error.textContent = err.message;
        button.disabled = false;
      }
    };
    document.querySelectorAll(".edit-student").forEach(
      (button) =>
        (button.onclick = () => {
          editingStudentId = button.dataset.id;
          render();
          $("#student-number").focus();
        }),
    );
    if ($("#cancel-edit"))
      $("#cancel-edit").onclick = () => {
        editingStudentId = null;
        render();
      };
    $("#search").oninput = (e) => {
      search = e.target.value;
      const pos = e.target.selectionStart;
      render();
      $("#search").focus();
      $("#search").setSelectionRange(pos, pos);
    };
    $("#student-class").onchange = (e) => {
      studentClass = e.target.value;
      render();
    };
    $("#student-status").onchange = (e) => {
      studentStatus = e.target.value;
      render();
    };
    document.querySelectorAll(".student-status-action").forEach(
      (button) =>
        (button.onclick = async () => {
          const student = state.students.find(
              (item) => item.id === button.dataset.id,
            ),
            nextStatus = button.dataset.status;
          if (!student || !confirm(`Mark ${student.name} as ${nextStatus}?`))
            return;
          try {
            if (schoolDataLive)
              await schoolApi(`/api/school/students/${student.id}`, {
                method: "PATCH",
                body: JSON.stringify({ status: nextStatus }),
              });
            else {
              student.status = nextStatus;
              save();
            }
            await (schoolDataLive ? loadSchoolStudents() : Promise.resolve());
            render();
            toast(`Student marked as ${nextStatus}.`);
          } catch (err) {
            toast(err.message);
          }
        }),
    );
    if (schoolDataLive && role !== "Administrator") {
      $("#student-form").closest("section").hidden = true;
      $("#student-import-panel").hidden = true;
      document
        .querySelectorAll(".edit-student,.student-status-action")
        .forEach((button) => (button.hidden = true));
    }
  }
  if (view === "attendance") {
    $("#print-attendance").onclick = printAttendanceReport;
    $("#attendance-csv").onclick = downloadAttendanceCsv;
    const switchContext = async (name, value) => {
      if (attendanceDraft && !confirm("Discard unsaved attendance changes?")) {
        render();
        return;
      }
      if (name === "date" && !value) {
        render();
        return;
      }
      attendanceDraft = null;
      if (name === "date") selectedDate = value;
      else selectedClass = value;
      if (schoolDataLive)
        try {
          await loadSchoolAttendance(selectedDate, selectedClass);
        } catch (err) {
          toast(err.message);
        }
      render();
    };
    $("#att-class").onchange = (e) => switchContext("class", e.target.value);
    $("#att-date").onchange = (e) => switchContext("date", e.target.value);
    document.querySelectorAll("[data-student].attendance-select").forEach(
      (s) =>
        (s.onchange = () => {
          attendanceDraft = {
            ...(attendanceDraft || state.attendance[selectedDate]?.marks || {}),
          };
          if (s.value === "unmarked") delete attendanceDraft[s.dataset.student];
          else attendanceDraft[s.dataset.student] = s.value;
          $("#attendance-status").textContent = "Unsaved changes";
        }),
    );
    $("#present-all").onclick = () => {
      attendanceDraft = {
        ...(attendanceDraft || state.attendance[selectedDate]?.marks || {}),
      };
      state.students
        .filter((s) => s.class === selectedClass)
        .forEach((s) => (attendanceDraft[s.id] = "present"));
      render();
    };
    $("#save-attendance").onclick = async () => {
      if (schoolDataLive) {
        const button = $("#save-attendance");
        button.disabled = true;
        try {
          const marks =
              attendanceDraft || state.attendance[selectedDate]?.marks || {},
            classStudentIds = new Set(
              state.students
                .filter((student) => student.class === selectedClass)
                .map((student) => student.id),
            ),
            classMarks = Object.fromEntries(
              Object.entries(marks).filter(([studentId]) =>
                classStudentIds.has(studentId),
              ),
            );
          await schoolApi("/api/school/attendance", {
            method: "POST",
            body: JSON.stringify({
              date: selectedDate,
              className: selectedClass,
              marks: classMarks,
            }),
          });
          attendanceDraft = null;
          await loadSchoolAttendance(selectedDate, selectedClass);
          render();
          toast("Attendance saved to Neon.");
        } catch (err) {
          button.disabled = false;
          toast(err.message);
        }
        return;
      }
      state.attendance[selectedDate] = {
        marks: {
          ...(attendanceDraft || state.attendance[selectedDate]?.marks || {}),
        },
        saved: new Date().toISOString(),
      };
      const persisted = save();
      attendanceDraft = null;
      render();
      if (persisted) toast("Attendance saved in this browser.");
    };
  }
  if (view === "fees") {
    $("#outstanding-print").onclick = () => printPaymentReport("outstanding");
    $("#paid-print").onclick = () => printPaymentReport("paid");
    $("#payment-print").onclick = () => printPaymentReport();
    $("#payment-excel").onclick = downloadPaymentReportExcel;
    document
      .querySelectorAll(".print-receipt")
      .forEach(
        (button) => (button.onclick = () => printReceipt(button.dataset.id)),
      );
    document
      .querySelectorAll(".print-statement")
      .forEach(
        (button) =>
          (button.onclick = () => printStudentStatement(button.dataset.id)),
      );
    document
      .querySelectorAll(".whatsapp-reminder")
      .forEach(
        (button) =>
          (button.onclick = () => openWhatsAppReminder(button.dataset.id)),
      );
    $("#payment-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const f = new FormData(e.target),
          studentId = f.get("student"),
          amount = cents(f.get("amount"));
        if (
          amount > Math.max(0, balance(state, studentId)) &&
          !confirm(
            "This payment creates or increases a credit. Record this overpayment?",
          )
        )
          return;
        if (schoolDataLive) {
          const button = e.target.querySelector(".button"),
            currentOperation = operation;
          button.disabled = true;
          const result = await schoolApi("/api/school/payments", {
            method: "POST",
            body: JSON.stringify({
              studentId,
              amountBututs: amount,
              operationKey: currentOperation,
            }),
          });
          operation = crypto.randomUUID();
          await loadSchoolFinance();
          render();
          $("#receipt").innerHTML =
            `<div class="note">Saved to Neon · Receipt <strong>${esc(result.payment.receipt_number)}</strong><br>${money(Number(result.payment.amount_bututs))} · ${esc(state.students.find((s) => s.id === studentId).name)}<br><button type="button" class="text-button" id="print-new-receipt">Print receipt</button></div>`;
          $("#print-new-receipt").onclick = () =>
            printReceipt(result.payment.id);
          return;
        }
        const receipt = recordPayment(state, {
          studentId,
          amount,
          operation,
          date: localDate(),
        });
        const persisted = save();
        operation = crypto.randomUUID();
        render();
        $("#receipt").innerHTML =
          `<div class="note">${persisted ? "Saved locally" : "In memory only"} · Receipt <strong>${esc(receipt.reference)}</strong><br>${money(receipt.amount)} · ${esc(state.students.find((s) => s.id === studentId).name)}<br><button type="button" class="text-button" id="print-new-receipt">Print receipt</button></div>`;
        $("#print-new-receipt").onclick = () => printReceipt(receipt.id);
      } catch (err) {
        $("#form-error").textContent = err.message;
        e.target.querySelector(".button").disabled = false;
      }
    };
    $("#charge-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const f = new FormData(e.target),
          label = f.get("label").trim(),
          amount = cents(f.get("amount"));
        if (!label) throw Error("Enter a charge description.");
        if (schoolDataLive) {
          const button = e.target.querySelector(".button");
          button.disabled = true;
          await schoolApi("/api/school/charges", {
            method: "POST",
            body: JSON.stringify({
              studentId: f.get("student"),
              description: label,
              amountBututs: amount,
            }),
          });
          await loadSchoolFinance();
          render();
          toast("Charge saved to Neon.");
          return;
        }
        state.charges.push({
          id: crypto.randomUUID(),
          studentId: f.get("student"),
          label,
          amount,
        });
        const persisted = save();
        render();
        if (persisted) toast("Demo charge saved.");
      } catch (err) {
        $("#charge-error").textContent = err.message;
        e.target.querySelector(".button").disabled = false;
      }
    };
    $("#class-charge-form").onsubmit = async (e) => {
      e.preventDefault();
      const form = new FormData(e.target),
        className = form.get("className"),
        label = form.get("label").trim(),
        classStudents = activeStudents().filter(
          (student) => student.class === className,
        );
      try {
        const amount = cents(form.get("amount"));
        if (!label || !classStudents.length)
          throw Error("Choose a class with active students and a fee type.");
        if (
          !confirm(
            `Charge ${money(amount)} to ${classStudents.length} active students in ${className}?`,
          )
        )
          return;
        const button = e.target.querySelector(".button");
        button.disabled = true;
        if (schoolDataLive) {
          const result = await schoolApi("/api/school/class-charges", {
            method: "POST",
            body: JSON.stringify({
              className,
              description: label,
              amountBututs: amount,
            }),
          });
          await loadSchoolFinance();
          render();
          toast(`${result.charged} students charged successfully.`);
          return;
        }
        for (const student of classStudents)
          state.charges.push({
            id: crypto.randomUUID(),
            studentId: student.id,
            label,
            amount,
          });
        save();
        render();
        toast(`${classStudents.length} demo students charged.`);
      } catch (err) {
        $("#class-charge-error").textContent = err.message;
        e.target.querySelector(".button").disabled = false;
      }
    };
  }
  if (view === "results") {
    $("#print-report-cards").onclick = printClassReportCards;
    if ($("#print-results")) $("#print-results").onclick = printResultsReport;
    if ($("#results-csv")) $("#results-csv").onclick = downloadResultsCsv;
    $("#res-class").onchange = async (e) => {
      selectedClass = e.target.value;
      if (schoolDataLive)
        try {
          await loadSchoolResults(selectedClass, selectedSubject);
        } catch (err) {
          toast(err.message);
        }
      render();
    };
    $("#res-subject").onchange = async (e) => {
      selectedSubject = e.target.value;
      if (schoolDataLive)
        try {
          await loadSchoolResults(selectedClass, selectedSubject);
        } catch (err) {
          toast(err.message);
        }
      render();
    };
    document.querySelectorAll(".mark-input").forEach(
      (input) =>
        (input.onchange = () => {
          const value = input.value;
          if (value === "") {
            delete state.marks[input.dataset.student];
            save();
            return;
          }
          const n = Number(value);
          if (
            !input.checkValidity() ||
            !Number.isFinite(n) ||
            n < 0 ||
            n > 100
          ) {
            input.reportValidity();
            $("#form-error").textContent = "Marks must be between 0 and 100.";
            return;
          }
          state.marks[input.dataset.student] = n;
          save();
          $("#form-error").textContent = "";
        }),
    );
    $("#publish").onclick = async () => {
      try {
        const inputs = [...document.querySelectorAll(".mark-input")];
        if (inputs.some((i) => !i.value || !i.checkValidity()))
          throw Error(
            "Enter a valid mark for every student before publishing.",
          );
        inputs.forEach(
          (i) => (state.marks[i.dataset.student] = Number(i.value)),
        );
        if (
          !confirm(
            `Approve and publish a new ${schoolDataLive ? "" : "fictional "}result snapshot for this class?`,
          )
        )
          return;
        if (schoolDataLive) {
          const button = $("#publish");
          button.disabled = true;
          await schoolApi("/api/school/results", {
            method: "POST",
            body: JSON.stringify({
              className: selectedClass,
              subjectName: selectedSubject,
              term: state.settings.term,
              marks: inputs.map((input) => ({
                studentId: input.dataset.student,
                score: Number(input.value),
              })),
            }),
          });
          await loadSchoolResults(selectedClass, selectedSubject);
          render();
          toast("Results published to Neon.");
          return;
        }
        const snap = publishResults(state, selectedClass, selectedSubject);
        const persisted = save();
        render();
        if (persisted)
          toast(`Demo results version ${snap.version} published locally.`);
      } catch (err) {
        $("#form-error").textContent = err.message;
        $("#publish").disabled = false;
      }
    };
  }
  if (view === "reports") {
    document
      .querySelectorAll(".export")
      .forEach((b) => (b.onclick = () => download(b.dataset.report)));
    $("#payment-excel").onclick = downloadPaymentReportExcel;
    $("#payment-print").onclick = printPaymentReport;
  }
  if (view === "settings") {
    $("#settings-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target),
        name = f.get("school").trim(),
        term = f.get("term").trim(),
        pass = Number(f.get("pass"));
      if (!name || !term || !Number.isInteger(pass) || pass < 0 || pass > 100) {
        $("#form-error").textContent =
          "Enter a name, term and valid threshold.";
        return;
      }
      if (schoolDataLive) {
        const button = e.target.querySelector(".button");
        button.disabled = true;
        try {
          await schoolApi("/api/school/settings", {
            method: "PATCH",
            body: JSON.stringify({ name, term, passMark: pass }),
          });
          activeSchool = { ...activeSchool, name, term, passMark: pass };
          state.settings = { ...state.settings, name, term, pass };
          render();
          toast("School settings saved to Neon.");
        } catch (err) {
          $("#form-error").textContent = err.message;
          button.disabled = false;
        }
        return;
      }
      state.settings = { ...state.settings, name, term, pass };
      const persisted = save();
      render();
      if (persisted) toast("Demo settings saved.");
    };
    $("#class-form").onsubmit = async (e) => {
      e.preventDefault();
      const name = new FormData(e.target).get("className").trim();
      if (!name) {
        $("#class-error").textContent = "Enter a class name.";
        return;
      }
      if (
        schoolClasses().some(
          (item) => item.toLowerCase() === name.toLowerCase(),
        )
      ) {
        $("#class-error").textContent = "That class already exists.";
        return;
      }
      if (schoolDataLive) {
        const button = e.target.querySelector(".button");
        button.disabled = true;
        try {
          await schoolApi("/api/school/classes", {
            method: "POST",
            body: JSON.stringify({ name }),
          });
          await loadSchoolStudents();
          render();
          toast("Class saved to Neon.");
        } catch (err) {
          $("#class-error").textContent = err.message;
          button.disabled = false;
        }
        return;
      }
      state.settings.classes.push(name);
      save();
      render();
      toast("Class added.");
    };
    document.querySelectorAll(".remove-class").forEach(
      (button) =>
        (button.onclick = async () => {
          const name = button.dataset.name;
          if (state.students.some((s) => s.class === name)) {
            toast("Move students to another class before removing it.");
            return;
          }
          if (schoolDataLive) {
            try {
              await schoolApi(
                `/api/school/classes/${schoolClassIds.get(name)}`,
                { method: "DELETE" },
              );
              await loadSchoolStudents();
              render();
              toast("Class removed.");
            } catch (err) {
              toast(err.message);
            }
            return;
          }
          state.settings.classes = state.settings.classes.filter(
            (item) => item !== name,
          );
          if (selectedClass === name) selectedClass = schoolClasses()[0];
          if (studentClass === name) studentClass = "";
          save();
          render();
          toast("Class removed.");
        }),
    );
    $("#fee-type-form").onsubmit = async (e) => {
      e.preventDefault();
      const name = new FormData(e.target).get("feeType").trim();
      if (!name) {
        $("#fee-type-error").textContent = "Enter a fee type.";
        return;
      }
      if (
        state.settings.feeTypes.some(
          (item) => item.toLowerCase() === name.toLowerCase(),
        )
      ) {
        $("#fee-type-error").textContent = "That fee type already exists.";
        return;
      }
      if (schoolDataLive) {
        const button = e.target.querySelector(".button");
        button.disabled = true;
        try {
          await schoolApi("/api/school/fee-types", {
            method: "POST",
            body: JSON.stringify({ name }),
          });
          await loadSchoolFinance();
          render();
          toast("Fee type saved to Neon.");
        } catch (err) {
          $("#fee-type-error").textContent = err.message;
          button.disabled = false;
        }
        return;
      }
      state.settings.feeTypes.push(name);
      save();
      render();
      toast("Fee type added.");
    };
    document.querySelectorAll(".remove-fee-type").forEach(
      (button) =>
        (button.onclick = async () => {
          const name = button.dataset.name;
          if (state.charges.some((c) => c.label === name)) {
            toast("This fee type is already used by a charge.");
            return;
          }
          if (schoolDataLive) {
            try {
              await schoolApi(
                `/api/school/fee-types/${schoolFeeTypeIds.get(name)}`,
                { method: "DELETE" },
              );
              await loadSchoolFinance();
              render();
              toast("Fee type removed.");
            } catch (err) {
              toast(err.message);
            }
            return;
          }
          state.settings.feeTypes = state.settings.feeTypes.filter(
            (item) => item !== name,
          );
          save();
          render();
          toast("Fee type removed.");
        }),
    );
    $("#subject-form").onsubmit = async (e) => {
      e.preventDefault();
      const name = new FormData(e.target).get("subjectName").trim();
      if (!name) return;
      if (
        state.settings.subjects.some(
          (subject) => subject.toLowerCase() === name.toLowerCase(),
        )
      ) {
        $("#subject-error").textContent = "That subject already exists.";
        return;
      }
      const button = e.target.querySelector(".button");
      button.disabled = true;
      try {
        if (schoolDataLive) {
          await schoolApi("/api/school/subjects", {
            method: "POST",
            body: JSON.stringify({ name }),
          });
          await loadSchoolStudents();
        } else {
          state.settings.subjects.push(name);
          save();
        }
        render();
        toast("Subject added.");
      } catch (err) {
        $("#subject-error").textContent = err.message;
        button.disabled = false;
      }
    };
    document.querySelectorAll(".remove-subject").forEach(
      (button) =>
        (button.onclick = async () => {
          const name = button.dataset.name;
          if (!confirm(`Remove ${name} from the school subjects?`)) return;
          try {
            if (schoolDataLive) {
              await schoolApi(
                `/api/school/subjects/${schoolSubjectIds.get(name)}`,
                { method: "DELETE" },
              );
              await loadSchoolStudents();
            } else {
              state.settings.subjects = state.settings.subjects.filter(
                (subject) => subject !== name,
              );
              save();
            }
            render();
            toast("Subject removed.");
          } catch (err) {
            toast(err.message);
          }
        }),
    );
  }
  if (view === "staff") {
    $("#staff-form").onsubmit = async (e) => {
      e.preventDefault();
      const button = e.target.querySelector(".button");
      button.disabled = true;
      try {
        await schoolApi("/api/school/staff", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
        });
        e.target.reset();
        await loadSchoolStaff();
        render();
        toast("Staff invitation email sent.");
      } catch (err) {
        $("#staff-error").textContent = err.message;
        button.disabled = false;
      }
    };
    document.querySelectorAll(".staff-role-select").forEach(
      (select) =>
        (select.onchange = async () => {
          try {
            await schoolApi(`/api/school/staff/${select.dataset.id}`, {
              method: "PATCH",
              body: JSON.stringify({ role: select.value }),
            });
            await loadSchoolStaff();
            render();
            toast("Staff role updated.");
          } catch (err) {
            toast(err.message);
            await loadSchoolStaff();
            render();
          }
        }),
    );
    document.querySelectorAll(".resend-staff").forEach(
      (button) =>
        (button.onclick = async () => {
          button.disabled = true;
          try {
            await schoolApi(`/api/school/staff/${button.dataset.id}/resend`, {
              method: "POST",
            });
            await loadSchoolStaff();
            render();
            toast("Staff invitation sent again.");
          } catch (err) {
            toast(err.message);
            button.disabled = false;
          }
        }),
    );
    document.querySelectorAll(".revoke-staff").forEach(
      (button) =>
        (button.onclick = async () => {
          if (!confirm(`Remove portal access for ${button.dataset.name}?`))
            return;
          try {
            await schoolApi(`/api/school/staff/${button.dataset.id}`, {
              method: "DELETE",
            });
            await loadSchoolStaff();
            render();
            toast("Staff access removed.");
          } catch (err) {
            toast(err.message);
          }
        }),
    );
  }
  if (view === "activity") {
    $("#refresh-activity").onclick = async () => {
      try {
        await loadSchoolActivity();
        render();
        toast("Activity log refreshed.");
      } catch (err) {
        toast(err.message);
      }
    };
  }
}
function download(type) {
  let rows;
  if (type === "students")
    rows = [
      ["Student number", "Name", "Class"],
      ...state.students.map((s) => [s.admission, s.name, s.class]),
    ];
  if (type === "fees")
    rows = [
      [
        "Type",
        "Reference",
        "Student number",
        "Student",
        "Description",
        "Date",
        "Amount GMD",
      ],
      ...state.charges.map((c) => {
        const s = state.students.find((s) => s.id === c.studentId);
        return [
          "Charge",
          c.id,
          s?.admission,
          s?.name,
          c.label,
          "",
          c.amount / 100,
        ];
      }),
      ...state.payments.map((p) => {
        const s = state.students.find((s) => s.id === p.studentId);
        return [
          "Payment",
          p.reference,
          s?.admission,
          s?.name,
          "Demo cash",
          p.date,
          -p.amount / 100,
        ];
      }),
    ];
  if (type === "results") {
    const latest = schoolClasses()
      .map((c) =>
        state.published
          .filter((p) => p.class === c && p.term === state.settings.term)
          .at(-1),
      )
      .filter(Boolean);
    if (!latest.length) {
      toast("Publish a class result snapshot before exporting.");
      return;
    }
    rows = [
      [
        "Student number",
        "Name",
        "Class",
        "Term",
        "Version",
        "Score",
        "Pass threshold",
        "Outcome",
      ],
      ...latest.flatMap((p) =>
        p.entries.map((e) => [
          e.admission,
          e.name,
          p.class,
          p.term,
          p.version,
          e.score,
          p.pass,
          e.score >= p.pass ? "Pass" : "Below threshold",
        ]),
      ),
    ];
  }
  const blob = new Blob(["\ufeff" + csv(rows)], {
      type: "text/csv;charset=utf-8",
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = "demo-" + type + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Fictional-data CSV downloaded.");
}
function paymentReportRows() {
  return state.students
    .map((student) => {
      const charges = state.charges
          .filter((item) => item.studentId === student.id)
          .reduce((total, item) => total + item.amount, 0),
        payments = state.payments
          .filter((item) => item.studentId === student.id)
          .reduce((total, item) => total + item.amount, 0);
      return { ...student, charges, payments, due: charges - payments };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
function reportGroups() {
  const rows = paymentReportRows();
  return {
    outstanding: rows.filter((row) => row.due > 0),
    paid: rows.filter((row) => row.due <= 0),
  };
}
function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function excelSheet(name, rows) {
  const excelRow = (values) =>
      `<Row>${values.map((value, index) => `<Cell ss:StyleID="${index > 2 ? "Money" : "Text"}"><Data ss:Type="${index > 2 ? "Number" : "String"}">${xml(value)}</Data></Cell>`).join("")}</Row>`,
    totalCharges = rows.reduce((sum, row) => sum + row.charges, 0),
    totalPayments = rows.reduce((sum, row) => sum + row.payments, 0),
    totalDue = rows.reduce((sum, row) => sum + row.due, 0);
  return `<Worksheet ss:Name="${xml(name)}"><Table><Column ss:Width="95"/><Column ss:Width="180"/><Column ss:Width="90"/><Column ss:Width="85"/><Column ss:Width="85"/><Column ss:Width="85"/><Row ss:StyleID="Title"><Cell ss:MergeAcross="5"><Data ss:Type="String">${xml(state.settings.name)} - ${xml(name)} Students</Data></Cell></Row><Row><Cell ss:MergeAcross="5"><Data ss:Type="String">${xml(state.settings.term)} | Generated ${xml(new Date().toLocaleDateString("en-GB"))}</Data></Cell></Row>${excelRow(["Student number", "Student name", "Class", "Charges (GMD)", "Paid (GMD)", "Balance (GMD)"])}${rows.map((row) => excelRow([row.admission, row.name, row.class, row.charges / 100, row.payments / 100, row.due / 100])).join("")}${excelRow(["", "TOTAL", `${rows.length} students`, totalCharges / 100, totalPayments / 100, totalDue / 100])}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>3</SplitHorizontal><TopRowBottomPane>3</TopRowBottomPane></WorksheetOptions></Worksheet>`;
}
function downloadPaymentReportExcel() {
  const groups = reportGroups(),
    workbook = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Text"><Alignment ss:Vertical="Center"/></Style><Style ss:ID="Title"><Font ss:Bold="1" ss:Size="14"/><Interior ss:Color="#EAF4EF" ss:Pattern="Solid"/></Style><Style ss:ID="Money"><NumberFormat ss:Format="#,##0.00"/></Style></Styles>${excelSheet("Outstanding", groups.outstanding)}${excelSheet("Fully Paid", groups.paid)}</Workbook>`,
    blob = new Blob([workbook], { type: "application/vnd.ms-excel" }),
    url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.settings.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-payment-status.xls`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Payment status Excel report downloaded.");
}
function printPaymentReport(group = "all") {
  const popup = window.open("", "_blank");
  if (!popup) {
    toast("Allow pop-ups to open the printable report.");
    return;
  }
  const groups = reportGroups(),
    section = (title, rows) =>
      `<section><h2>${esc(title)} <small>${rows.length} students</small></h2><table><thead><tr><th>Student number</th><th>Name</th><th>Class</th><th>Charges</th><th>Paid</th><th>Balance</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.admission)}</td><td>${esc(row.name)}</td><td>${esc(row.class)}</td><td>${money(row.charges)}</td><td>${money(row.payments)}</td><td>${money(row.due)}</td></tr>`).join("") || '<tr><td colspan="6">No students in this category.</td></tr>'}</tbody><tfoot><tr><th colspan="3">Total</th><th>${money(rows.reduce((sum, row) => sum + row.charges, 0))}</th><th>${money(rows.reduce((sum, row) => sum + row.payments, 0))}</th><th>${money(rows.reduce((sum, row) => sum + row.due, 0))}</th></tr></tfoot></table></section>`;
  const content =
    group === "outstanding"
      ? section("Students with outstanding payments", groups.outstanding)
      : group === "paid"
        ? section("Students fully paid", groups.paid)
        : section("Students with outstanding payments", groups.outstanding) +
          section("Students fully paid", groups.paid);
  popup.document.write(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Status Report</title><style>@page{size:A4 landscape;margin:14mm}body{font:12px Arial;color:#203330;margin:0;padding:12px}header{border-bottom:3px solid #146a56;padding-bottom:12px;margin-bottom:22px}h1{margin:0 0 6px;font-size:24px}p,small{color:#60736d}section{break-inside:avoid;margin:0 0 28px}h2{font-size:16px;margin-bottom:10px}h2 small{float:right;font-weight:normal}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #dce6e1;text-align:left}thead th{background:#eaf4ef}td:nth-child(n+4),th:nth-child(n+4){text-align:right}tfoot th{background:#f5f7f6}@media(max-width:700px){body{overflow-x:auto}table{min-width:720px}}@media print{button{display:none}body{padding:0}}</style></head><body><header><h1>${esc(state.settings.name)}</h1><p>Payment Status Report | ${esc(state.settings.term)} | Generated ${esc(new Date().toLocaleDateString("en-GB"))}</p><button onclick="window.print()">Print or save as PDF</button></header>${content}</body></html>`,
  );
  popup.document.close();
}
$("#reset").onclick = () => {
  if (
    !confirm(
      "Reset all demo records in this browser? This removes your prototype edits.",
    )
  )
    return;
  state = seed();
  attendanceDraft = null;
  operation = crypto.randomUUID();
  const persisted = save();
  render();
  if (persisted) toast("Fictional demo records restored.");
};
window.addEventListener("hashchange", () => {
  attendanceDraft = null;
  if (!$(".layout").hidden) render();
});
window.addEventListener("beforeunload", (e) => {
  if (attendanceDraft) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function sessionData(result) {
  return result?.data ?? result;
}
function sessionFromResult(result) {
  const data = sessionData(result);
  if (data?.user && data?.session?.token) return data;
  if (data?.user && data?.token)
    return { user: data.user, session: { token: data.token } };
  return null;
}
async function resolvedSession(authResult) {
  const direct = sessionFromResult(authResult);
  if (direct) return direct;
  return sessionFromResult(await auth.getSession());
}
async function authenticatedToken() {
  const response = await fetch("/api/auth/token", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    }),
    data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Error(
      data.message ||
        data.error ||
        `Secure token request failed (${response.status}).`,
    );
  const token = data.token;
  if (!token || token.split(".").length !== 3)
    throw Error(
      "The secure login token could not be created. Please sign in again.",
    );
  return token;
}
function showAuthPanel(id) {
  [
    "login-panel",
    "reset-request-panel",
    "reset-password-panel",
    "invitation-panel",
  ].forEach((panel) => {
    const element = $("#" + panel);
    element.hidden = panel !== id;
    element.style.display = panel === id ? "block" : "none";
  });
}
async function showPortal(session) {
  const authScreen = $("#auth-screen"),
    layout = $(".layout"),
    email = session?.user?.email || "";
  accessToken = await authenticatedToken();
  const response = await fetch("/api/me", {
    headers: { Authorization: "Bearer " + accessToken },
  });
  const account = await response.json();
  if (!response.ok) throw Error(account.error || "Account access unavailable.");
  isPlatformOwner = account.user.role === "platform_owner";
  activeSchool = account.school;
  role =
    account.user.role === "teacher"
      ? "Teacher"
      : account.user.role === "finance"
        ? "Finance"
        : "Administrator";
  $("#role").textContent = isPlatformOwner ? "Platform Owner" : role;
  if (activeSchool) {
    state.settings.name = activeSchool.name;
    state.settings.term = activeSchool.term;
    state.settings.pass = activeSchool.passMark;
    await loadSchoolStudents();
    if (role === "Administrator" || role === "Finance")
      await loadSchoolFinance();
    else {
      state.charges = [];
      state.payments = [];
    }
    if (role === "Administrator" || role === "Teacher") {
      await loadSchoolAttendance();
      await loadSchoolResults();
    }
    if (role === "Administrator") {
      await loadSchoolStaff();
      await loadSchoolActivity();
    }
  }
  $("#workspace-status").textContent = activeSchool ? "PILOT" : "DEMO";
  $("#workspace-message").textContent = activeSchool
    ? "Secure login and live Neon school records are active."
    : "Secure login is active. This workspace contains demonstration records.";
  $("#reset").hidden = Boolean(activeSchool);
  authScreen.hidden = true;
  authScreen.style.display = "none";
  layout.hidden = false;
  layout.style.display = "";
  $("#signed-in-user").textContent = email || "Signed in";
  render();
  if (isPlatformOwner) loadSchools();
  if (storageWarning)
    toast("Stored demo data could not be read; fictional examples loaded.");
}
function showLogin(message = "") {
  const authScreen = $("#auth-screen"),
    layout = $(".layout");
  layout.hidden = true;
  layout.style.display = "none";
  authScreen.hidden = false;
  authScreen.style.display = "grid";
  showAuthPanel("login-panel");
  $("#login-error").textContent = message;
}
async function initializeAuth() {
  const params = new URLSearchParams(location.search),
    resetToken = params.get("token"),
    inviteToken = params.get("invite");
  if (resetToken) {
    showLogin();
    showAuthPanel("reset-password-panel");
    return;
  }
  if (inviteToken) {
    showLogin();
    showAuthPanel("invitation-panel");
    try {
      const response = await fetch(
          `/api/invitations/${encodeURIComponent(inviteToken)}`,
        ),
        data = await response.json();
      if (!response.ok) throw Error(data.error || "Invitation unavailable.");
      $("#invitation-title").textContent = `Join ${data.invitation.name}`;
      $("#invitation-details").textContent = data.invitation.role
        ? `Create your ${data.invitation.role === "finance" ? "Finance" : "Teacher"} account to join this school workspace.`
        : "Create your administrator account to activate this school workspace.";
      $("#invitation-name").value = data.invitation.administrator_name;
      $("#invitation-email").value = data.invitation.administrator_email;
      const session = sessionFromResult(await auth.getSession());
      if (session?.user) await acceptInvitation(inviteToken, session);
    } catch (err) {
      $("#invitation-error").textContent = err.message;
    }
    return;
  }
  try {
    const session = sessionFromResult(await auth.getSession());
    if (session?.user) {
      await showPortal(session);
      return;
    }
  } catch {}
  showLogin();
}
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button"),
    error = $("#login-error"),
    form = new FormData(e.target);
  error.textContent = "";
  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    const result = await auth.signIn.email({
      email: String(form.get("email")).trim(),
      password: String(form.get("password")),
    });
    if (result?.error) throw Error(result.error.message || "Sign-in failed.");
    const session = await resolvedSession(result);
    if (!session?.user) throw Error("The session could not be created.");
    const inviteToken = new URLSearchParams(location.search).get("invite");
    if (inviteToken) await acceptInvitation(inviteToken, session);
    else await showPortal(session);
  } catch (err) {
    showLogin(
      err?.message || "Unable to sign in. Check your email and password.",
    );
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
};
async function acceptInvitation(token, session) {
  const jwt = await authenticatedToken();
  const response = await fetch(
      `/api/invitations/${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      },
    ),
    data = await response.json();
  if (!response.ok)
    throw Error(data.error || "Unable to activate this school.");
  history.replaceState({}, "", location.pathname);
  await showPortal(session);
  toast("School portal activated successfully.");
}
$("#invitation-form").onsubmit = async (e) => {
  e.preventDefault();
  const form = new FormData(e.target),
    password = String(form.get("password")),
    confirmation = String(form.get("confirmation")),
    button = e.target.querySelector(".button"),
    error = $("#invitation-error"),
    token = new URLSearchParams(location.search).get("invite");
  error.textContent = "";
  if (password !== confirmation) {
    error.textContent = "The passwords do not match.";
    return;
  }
  button.disabled = true;
  button.textContent = "Creating account…";
  try {
    const result = await auth.signUp.email({
      name: String(form.get("name")).trim(),
      email: String(form.get("email")).trim(),
      password,
    });
    if (result?.error)
      throw Error(result.error.message || "Account creation failed.");
    const session = await resolvedSession(result);
    if (!session?.user)
      throw Error("Account created. Please sign in to finish activation.");
    await acceptInvitation(token, session);
  } catch (err) {
    error.textContent = err?.message || "Unable to activate the school.";
  } finally {
    button.disabled = false;
    button.textContent = "Create account and activate";
  }
};
$("#invitation-existing").onclick = () => {
  const email = $("#invitation-email").value;
  showLogin("Sign in to accept your school invitation.");
  $("#login-email").value = email;
};
$("#sign-out").onclick = async () => {
  try {
    await auth.signOut();
  } finally {
    showLogin("You have signed out.");
  }
};
$("#forgot-password").onclick = () => {
  const email = $("#login-email").value.trim();
  $("#reset-email").value = email;
  $("#reset-request-message").textContent = "";
  showAuthPanel("reset-request-panel");
};
document
  .querySelectorAll(".back-to-login")
  .forEach((button) => (button.onclick = () => showAuthPanel("login-panel")));
$("#reset-request-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.target.querySelector(".button"),
    email = new FormData(e.target).get("email").trim(),
    message = $("#reset-request-message");
  button.disabled = true;
  button.textContent = "Sending…";
  message.textContent = "";
  try {
    const result = await auth.requestPasswordReset({
      email,
      redirectTo: location.origin + "/?password-reset=1",
      callbackURL: location.origin + "/?password-reset=1",
    });
    if (result?.error)
      throw Error(result.error.message || "Unable to send the password email.");
    message.textContent =
      "If the account exists, a password link has been sent. Check the inbox and spam folder.";
  } catch (err) {
    message.textContent = err?.message || "Unable to send the password email.";
  } finally {
    button.disabled = false;
    button.textContent = "Email password link";
  }
};
$("#reset-password-form").onsubmit = async (e) => {
  e.preventDefault();
  const form = new FormData(e.target),
    password = String(form.get("password")),
    confirmation = String(form.get("confirmation")),
    error = $("#reset-password-error"),
    button = e.target.querySelector(".button"),
    token = new URLSearchParams(location.search).get("token");
  error.textContent = "";
  if (password !== confirmation) {
    error.textContent = "The passwords do not match.";
    return;
  }
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const result = await auth.resetPassword({ newPassword: password, token });
    if (result?.error)
      throw Error(result.error.message || "Unable to save the password.");
    history.replaceState({}, "", location.pathname);
    showLogin("Password saved. You can now sign in.");
  } catch (err) {
    error.textContent =
      err?.message || "This password link is invalid or expired.";
  } finally {
    button.disabled = false;
    button.textContent = "Save password";
  }
};
initializeAuth();
