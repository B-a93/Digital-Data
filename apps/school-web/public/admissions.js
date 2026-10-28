const form = document.querySelector("#admission-form");
const message = document.querySelector("#admission-message");
const schoolInput = document.querySelector("#school-code");
const button = form.querySelector("button[type=submit]");
const suppliedSchool = new URLSearchParams(location.search).get("school");
let verifiedSchool = null;
let schoolReady = suppliedSchool === null;
async function resolveSchool() {
  if (suppliedSchool === null) return;
  button.disabled = true;
  schoolInput.value = suppliedSchool.trim().toLowerCase();
  schoolInput.readOnly = true;
  message.textContent = "Checking the school’s admission link…";
  try {
    const response = await fetch(`/api/admission-school?school=${encodeURIComponent(schoolInput.value)}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.school?.code || !result.school?.name)
      throw Error(result.error || "We could not verify this school. Reload to try again, or contact the school.");
    verifiedSchool = result.school;
    schoolInput.value = verifiedSchool.code;
    schoolInput.defaultValue = verifiedSchool.code;
    document.querySelector("#school-code-field").hidden = true;
    document.querySelector("#admission-school-title").textContent = `Apply to ${verifiedSchool.name}`;
    document.querySelector("#admission-introduction").textContent = `Your application will be sent to ${verifiedSchool.name} for review. Submitting this form does not guarantee admission.`;
    document.querySelector("#admission-help").textContent = "Have the learner’s details and a parent or guardian’s contact information ready. Your school is already selected.";
    document.title = `Apply to ${verifiedSchool.name} | School Management Portal`;
    schoolReady = true;
    message.textContent = "School confirmed. Complete the application below.";
    button.disabled = false;
  } catch (error) {
    message.textContent = error.message;
    document.querySelector("#admission-school-title").textContent = "Admission link unavailable";
    document.querySelector("#admission-introduction").textContent = "Please confirm the application link with the school before entering student information.";
  }
}
resolveSchool();
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!schoolReady || button.disabled) return;
  form.classList.add("was-validated");
  if (!form.checkValidity()) {
    form.reportValidity();
    message.textContent = "Complete the required fields before submitting.";
    return;
  }
  button.disabled = true;
  message.textContent = "Submitting application…";
  try {
    const payload = Object.fromEntries(new FormData(form));
    payload.schoolCode = verifiedSchool?.code || payload.schoolCode.trim().toLowerCase();
    const response = await fetch("/api/admissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || "The application could not be submitted.");
    form.reset();
    if (verifiedSchool) schoolInput.value = verifiedSchool.code;
    form.classList.remove("was-validated");
    message.textContent = `${result.message} Application reference: ${result.application.id}`;
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = !schoolReady;
  }
});
