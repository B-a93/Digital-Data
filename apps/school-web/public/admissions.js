const form = document.querySelector("#admission-form");
const message = document.querySelector("#admission-message");
const suppliedSchool = new URLSearchParams(location.search).get("school");
if (suppliedSchool) document.querySelector("#school-code").value = suppliedSchool;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  form.classList.add("was-validated");
  if (!form.checkValidity()) {
    form.reportValidity();
    message.textContent = "Complete the required fields before submitting.";
    return;
  }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  message.textContent = "Submitting application…";
  try {
    const payload = Object.fromEntries(new FormData(form));
    payload.schoolCode = payload.schoolCode.trim().toLowerCase();
    const response = await fetch("/api/admissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || "The application could not be submitted.");
    form.reset();
    form.classList.remove("was-validated");
    message.textContent = `${result.message} Application reference: ${result.application.id}`;
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
