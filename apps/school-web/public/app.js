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
let view = "dashboard",
  selectedClass = state.settings.classes[0],
  selectedDate = localDate(),
  search = "",
  studentClass = "",
  operation = crypto.randomUUID(),
  role = "Administrator",
  editingStudentId = null,
  accessToken = "",
  isPlatformOwner = false,
  activeSchool = null,
  schoolDataLive = false,
  platformSchools = [];
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
  ["settings", "⚙", "Settings"],
];
const visibleNav = () =>
  isPlatformOwner
    ? [["platform", "◆", "School onboarding"], ...navItems]
    : navItems;
function heading(title, subtitle, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
function table(heads, rows) {
  return `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${heads.length}" class="empty">No matching records.</td></tr>`}</tbody></table></div>`;
}
function studentCell(s) {
  return `<span class="student-name">${esc(s.name)}</span><span class="sub">${esc(s.admission)}</span>`;
}
function badge(n) {
  return n > 0
    ? '<span class="badge amber">Outstanding</span>'
    : n < 0
      ? '<span class="badge">Credit</span>'
      : '<span class="badge">Paid</span>';
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
  if (data.classes.length)
    state.settings.classes = data.classes.map((item) => item.name);
  state.students = data.students.map((student) => ({
    id: student.id,
    admission: student.student_number,
    name: student.full_name,
    class: student.class_name || "Unassigned",
  }));
  state.attendance = {};
  state.marks = {};
  state.published = [];
  selectedClass = state.settings.classes[0];
  schoolDataLive = true;
}
async function loadSchoolFinance() {
  const data = await schoolApi("/api/school/finance");
  if (data.feeTypes.length)
    state.settings.feeTypes = data.feeTypes.map((item) => item.name);
  state.charges = data.charges.map((charge) => ({
    id: charge.id,
    studentId: charge.student_id,
    label: charge.description,
    amount: Number(charge.amount_bututs),
  }));
  state.payments = data.payments.map((payment) => ({
    id: payment.id,
    studentId: payment.student_id,
    amount: Number(payment.amount_bututs),
    reference: payment.receipt_number,
    date: String(payment.paid_on).slice(0, 10),
  }));
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
async function loadSchoolResults(className = selectedClass) {
  if (!schoolDataLive || !className) return;
  const data = await schoolApi(
    `/api/school/results?class=${encodeURIComponent(className)}&term=${encodeURIComponent(state.settings.term)}`,
  );
  const classStudentIds = new Set(
    state.students
      .filter((student) => student.class === className)
      .map((student) => student.id),
  );
  for (const studentId of classStudentIds) delete state.marks[studentId];
  state.published = state.published.filter(
    (item) => !(item.class === className && item.term === state.settings.term),
  );
  if (!data.assessment) return;
  for (const mark of data.marks)
    state.marks[mark.student_id] = Number(mark.score);
  state.published.push({
    class: className,
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
      "Across " + schoolClasses().length + " demo classes",
      "♙",
    ],
    [
      "Recorded payments",
      money(paid),
      "Demo transactions · not actual collections",
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
      "Welcome back. Here’s your fictional school workspace.",
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
    )}</section><section class="panel"><div class="panel-heading"><h2>Fees at a glance</h2><small>Current demo ledger</small></div><div class="number">${money(paid)}</div><p>recorded against ${money(charges)} in charges</p><div class="bar" role="meter" aria-label="Payments relative to charges" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${charges ? Math.min(100, Math.round((paid / charges) * 100)) : 0}"><div class="bar-fill" id="fee-bar"></div></div><div class="bar-row"><div class="bar-label"><span>Total charges</span><strong>${money(charges)}</strong></div><div class="bar-label"><span>Unpaid student balances</span><strong>${money(outstanding)}</strong></div></div><div class="quick-actions"><a class="button secondary" href="#fees">Record payment</a><a class="button secondary" href="#reports">Export report</a></div><div class="note">Start with one workflow at a time. This prototype uses fictional records stored only in this browser.</div></section><section class="panel wide"><div class="panel-heading"><h2>Your next tasks</h2><span class="badge gray">${esc(role)} demo view</span></div><div class="quick-actions">${(role ===
    "Teacher"
      ? [
          ["attendance", "Take class attendance"],
          ["results", "Enter draft marks"],
        ]
      : role === "Finance"
        ? [
            ["fees", "Review fee balances"],
            ["reports", "Download demo ledger"],
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
        `${s.name} ${s.admission}`.toLowerCase().includes(search.toLowerCase()),
    ),
    editing = state.students.find((s) => s.id === editingStudentId);
  return (
    heading(
      "Students",
      "Keep a clear register of enrolment and class assignments.",
    ) +
    `<div class="stack"><section class="panel"><div class="panel-heading"><h2>${editing ? "Edit student" : schoolDataLive ? "Register a student" : "Register a fictional student"}</h2><span class="badge gray">${schoolDataLive ? "Neon record" : "Demo record"}</span></div><form id="student-form"><div class="form-grid"><div class="field"><label for="student-number">Student number</label><input id="student-number" name="studentNumber" maxlength="30" required autocomplete="off" placeholder="e.g. STU-2026-001" value="${esc(editing?.admission || "")}"></div><div class="field"><label for="name">Student full name</label><input id="name" name="name" maxlength="80" required placeholder="e.g. Awa Example" value="${esc(editing?.name || "")}"></div><div class="field"><label for="new-class">Class</label><select id="new-class" name="class">${options(schoolClasses(), editing?.class || schoolClasses()[0])}</select></div></div><div class="form-actions"><button class="button">${editing ? "Save changes" : "Add student"}</button>${editing ? '<button type="button" class="button secondary" id="cancel-edit">Cancel</button>' : ""}<span class="status-text">Each student number must be unique within this school.</span></div><div class="error" id="form-error" role="alert"></div></form></section><section class="panel"><div class="panel-heading"><h2>Student register</h2><small>${list.length} students</small></div><div class="toolbar"><input id="search" type="search" aria-label="Search students" value="${esc(search)}" placeholder="Search name or student number"><select id="student-class" aria-label="Filter students by class"><option value="">All classes</option>${options(schoolClasses(), studentClass)}</select></div>${table(["Student", "Class", "Balance", "Action"], list.map((s) => `<tr><td>${studentCell(s)}</td><td>${esc(s.class)}</td><td>${money(balance(state, s.id))}</td><td><button class="text-button edit-student" data-id="${s.id}">Edit</button></td></tr>`).join(""))}</section></div>`
  );
}
function attendance() {
  const list = state.students.filter((s) => s.class === selectedClass),
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
    `<section class="panel"><div class="toolbar"><label for="att-class">Class</label><select id="att-class">${options(schoolClasses(), selectedClass)}</select><label for="att-date">Date</label><input id="att-date" type="date" value="${selectedDate}" required><span class="badge ${count === list.length ? "" : "amber"}">${count}/${list.length} marked</span></div>${table(["Student", "Attendance"], list.map((s) => `<tr><td>${studentCell(s)}</td><td><select class="attendance-select" data-student="${s.id}" aria-label="Attendance for ${esc(s.name)}">${options(["unmarked", "present", "late", "absent", "excused"], marks[s.id] || "unmarked")}</select></td></tr>`).join(""))}<div class="form-actions"><button class="button" id="save-attendance">Save attendance</button><button class="button secondary" id="present-all">Mark class present</button><span class="status-text" id="attendance-status">${attendanceDraft ? "Unsaved changes" : record.saved ? `${schoolDataLive ? "Saved to Neon" : "Saved in browser"} · ${count === list.length ? "class complete" : "class incomplete"}` : "Not saved yet"}</span></div><div class="note">Attendance rate = present + late divided by present + late + absent. Excused and unmarked are excluded.</div></section>`
  );
}
function fees() {
  return (
    heading(
      "Fees & payments",
      schoolDataLive
        ? "Review charges, record receipts and see outstanding balances."
        : "Review charges, record demo receipts and see outstanding balances.",
    ) +
    `<div class="grid"><section class="panel"><div class="panel-heading"><h2>Record ${schoolDataLive ? "a" : "a demo"} payment</h2></div><form id="payment-form"><div class="field"><label for="pay-student">Student</label><select id="pay-student" name="student">${state.students.map((s) => `<option value="${s.id}">${esc(s.name)} · ${esc(s.admission)}</option>`).join("")}</select></div><div class="field"><label for="amount">Amount in dalasi</label><input id="amount" name="amount" type="text" inputmode="decimal" required placeholder="1500.00"></div><div class="note">Overpayment becomes a displayed credit, not an automatic refund.</div><div class="form-actions"><button class="button">Record payment</button></div><div id="form-error" class="error" role="alert"></div><div id="receipt" role="status"></div></form></section><section class="panel"><div class="panel-heading"><h2>Add ${schoolDataLive ? "a" : "a demo"} charge</h2></div><form id="charge-form"><div class="field"><label for="charge-student">Student</label><select id="charge-student" name="student">${state.students.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></div><div class="field"><label for="charge-label">Fee type</label><select id="charge-label" name="label">${options(state.settings.feeTypes, state.settings.feeTypes[0])}</select></div><div class="field"><label for="charge-amount">Amount in dalasi</label><input id="charge-amount" name="amount" inputmode="decimal" required placeholder="1500.00"></div><div class="form-actions"><button class="button secondary">Add charge</button></div><div id="charge-error" class="error" role="alert"></div></form></section><section class="panel wide"><div class="panel-heading"><h2>Student balances</h2><small>Negative balance = credit</small></div>${table(["Student", "Class", "Balance", "Status"], state.students.map((s) => `<tr><td>${studentCell(s)}</td><td>${esc(s.class)}</td><td>${money(balance(state, s.id))}</td><td>${badge(balance(state, s.id))}</td></tr>`).join(""))}</section><section class="panel wide"><div class="panel-heading"><h2>Recent ${schoolDataLive ? "" : "demo "}receipts</h2></div>${table(
      ["Receipt", "Student", "Date", "Amount"],
      state.payments
        .slice()
        .reverse()
        .slice(0, 10)
        .map(
          (p) =>
            `<tr><td>${esc(p.reference)}</td><td>${esc(state.students.find((s) => s.id === p.studentId)?.name)}</td><td>${esc(p.date)}</td><td>${money(p.amount)}</td></tr>`,
        )
        .join(""),
    )}</section></div>`
  );
}
function results() {
  const list = state.students.filter((s) => s.class === selectedClass),
    snap = state.published
      .filter(
        (p) => p.class === selectedClass && p.term === state.settings.term,
      )
      .at(-1);
  return (
    heading(
      "Results",
      "Prepare a single demo assessment, then publish a versioned snapshot.",
    ) +
    `<section class="panel"><div class="toolbar"><label for="res-class">Class</label><select id="res-class">${options(schoolClasses(), selectedClass)}</select><span class="badge gray">Draft assessment · /100</span><span class="status-text">Pass threshold: ${state.settings.pass}</span></div>${table(["Student", "Draft mark /100"], list.map((s) => `<tr><td>${studentCell(s)}</td><td><input class="money-input mark-input" type="number" min="0" max="100" step="0.01" data-student="${s.id}" aria-label="Mark for ${esc(s.name)}" value="${state.marks[s.id] ?? ""}"></td></tr>`).join(""))}<div class="form-actions"><button class="button" id="publish">Approve & publish demo results</button><span class="status-text">Draft marks save on change in this browser.</span></div><div class="error" id="form-error" role="alert"></div><div class="note">Prototype combines review and publication. Production must enforce authorised academic approval. A published snapshot does not change when draft marks change.</div></section>${snap ? `<section class="panel"><div class="panel-heading"><h2>Published snapshot · version ${snap.version}</h2><small>${esc(snap.term)}</small></div>${table(["Student", "Published score", "Outcome"], snap.entries.map((e) => `<tr><td>${esc(e.name)}</td><td>${e.score}</td><td><span class="badge ${e.score >= snap.pass ? "" : "amber"}">${e.score >= snap.pass ? "Pass" : "Below threshold"}</span></td></tr>`).join(""))}</section>` : ""}`
  );
}
function reports() {
  return (
    heading(
      "Reports",
      "Download fictional records for review—not official school documents.",
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
        "Individual demo charges and receipts with signed amounts.",
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
      )}<div class="note">Exports currently include this school workspace’s browser demo records. Real Neon student and payment records will replace them in the production stage.</div></section></div>`
  );
}
function settings() {
  return (
    heading(
      "School settings",
      "Manage the school details, classes and fee types used in this demo.",
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
    )}<div class="note">A fee type cannot be removed after it has been used for a charge.</div></section><div class="note">Published results retain their original term and threshold. These prototype settings are stored only in this browser.</div></div>`
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
        editingStudentId = null;
      } else
        state.students.push({
          id: crypto.randomUUID(),
          admission: studentNumber,
          name,
          class: f.get("class"),
        });
      save();
      render();
      toast(
        editing
          ? "Student details updated."
          : "Fictional student added. No fee charge created automatically.",
      );
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
  }
  if (view === "attendance") {
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
            `<div class="note">Saved to Neon · Receipt <strong>${esc(result.payment.receipt_number)}</strong><br>${money(Number(result.payment.amount_bututs))} · ${esc(state.students.find((s) => s.id === studentId).name)}</div>`;
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
          `<div class="note">${persisted ? "Saved locally" : "In memory only"} · Receipt <strong>${esc(receipt.reference)}</strong><br>${money(receipt.amount)} · ${esc(state.students.find((s) => s.id === studentId).name)}</div>`;
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
  }
  if (view === "results") {
    $("#res-class").onchange = async (e) => {
      selectedClass = e.target.value;
      if (schoolDataLive)
        try {
          await loadSchoolResults(selectedClass);
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
              term: state.settings.term,
              marks: inputs.map((input) => ({
                studentId: input.dataset.student,
                score: Number(input.value),
              })),
            }),
          });
          await loadSchoolResults(selectedClass);
          render();
          toast("Results published to Neon.");
          return;
        }
        const snap = publishResults(state, selectedClass);
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
    $("#settings-form").onsubmit = (e) => {
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
      state.settings = { ...state.settings, name, term, pass };
      const persisted = save();
      render();
      if (persisted) toast("Demo settings saved.");
    };
    $("#class-form").onsubmit = (e) => {
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
      state.settings.classes.push(name);
      save();
      render();
      toast("Class added.");
    };
    document.querySelectorAll(".remove-class").forEach(
      (button) =>
        (button.onclick = () => {
          const name = button.dataset.name;
          if (state.students.some((s) => s.class === name)) {
            toast("Move students to another class before removing it.");
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
    $("#fee-type-form").onsubmit = (e) => {
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
      state.settings.feeTypes.push(name);
      save();
      render();
      toast("Fee type added.");
    };
    document.querySelectorAll(".remove-fee-type").forEach(
      (button) =>
        (button.onclick = () => {
          const name = button.dataset.name;
          if (state.charges.some((c) => c.label === name)) {
            toast("This fee type is already used by a charge.");
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
function printPaymentReport() {
  const popup = window.open("", "_blank");
  if (!popup) {
    toast("Allow pop-ups to open the printable report.");
    return;
  }
  const groups = reportGroups(),
    section = (title, rows) =>
      `<section><h2>${esc(title)} <small>${rows.length} students</small></h2><table><thead><tr><th>Student number</th><th>Name</th><th>Class</th><th>Charges</th><th>Paid</th><th>Balance</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.admission)}</td><td>${esc(row.name)}</td><td>${esc(row.class)}</td><td>${money(row.charges)}</td><td>${money(row.payments)}</td><td>${money(row.due)}</td></tr>`).join("") || '<tr><td colspan="6">No students in this category.</td></tr>'}</tbody><tfoot><tr><th colspan="3">Total</th><th>${money(rows.reduce((sum, row) => sum + row.charges, 0))}</th><th>${money(rows.reduce((sum, row) => sum + row.payments, 0))}</th><th>${money(rows.reduce((sum, row) => sum + row.due, 0))}</th></tr></tfoot></table></section>`;
  popup.document.write(
    `<!doctype html><html><head><title>Payment Status Report</title><style>@page{size:A4 landscape;margin:14mm}body{font:12px Arial;color:#203330;margin:0}header{border-bottom:3px solid #146a56;padding-bottom:12px;margin-bottom:22px}h1{margin:0 0 6px;font-size:24px}p,small{color:#60736d}section{break-inside:avoid;margin:0 0 28px}h2{font-size:16px;margin-bottom:10px}h2 small{float:right;font-weight:normal}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #dce6e1;text-align:left}thead th{background:#eaf4ef}td:nth-child(n+4),th:nth-child(n+4){text-align:right}tfoot th{background:#f5f7f6}@media print{button{display:none}}</style></head><body><header><h1>${esc(state.settings.name)}</h1><p>Payment Status Report | ${esc(state.settings.term)} | Generated ${esc(new Date().toLocaleDateString("en-GB"))}</p><button onclick="window.print()">Print or save as PDF</button></header>${section("Students with outstanding payments", groups.outstanding)}${section("Students fully paid", groups.paid)}</body></html>`,
  );
  popup.document.close();
}
$("#role").onchange = (e) => {
  role = e.target.value;
  render();
};
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
  accessToken = session?.session?.token || "";
  const response = await fetch("/api/me", {
    headers: { Authorization: "Bearer " + accessToken },
  });
  const account = await response.json();
  if (!response.ok) throw Error(account.error || "Account access unavailable.");
  isPlatformOwner = account.user.role === "platform_owner";
  activeSchool = account.school;
  if (activeSchool) {
    state.settings.name = activeSchool.name;
    state.settings.term = activeSchool.term;
    await loadSchoolStudents();
    await loadSchoolFinance();
    await loadSchoolAttendance();
    await loadSchoolResults();
  }
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
      $("#invitation-details").textContent =
        "Create your administrator account to activate this school workspace.";
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
  const response = await fetch(
      `/api/invitations/${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${session.session.token}` },
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
