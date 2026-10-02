const form = document.querySelector("#onboarding-request-form");
const error = document.querySelector("#onboarding-error");
const success = document.querySelector("#onboarding-success");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button[type='submit']");
  error.textContent = "";
  success.hidden = true;
  form.classList.add("was-validated");
  if (!form.checkValidity()) {
    const invalid = form.querySelector(":invalid");
    error.textContent =
      "Please complete all required fields marked with *. Check the institution type, both Data Import choices and the data-retention agreement.";
    invalid?.scrollIntoView({ behavior: "smooth", block: "center" });
    invalid?.focus({ preventScroll: true });
    return;
  }
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const fields = new FormData(form);
    const response = await fetch("/api/onboarding-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        onboardingMode: fields.get("onboardingMode"),
        organisationName: fields.get("organisationName"),
        organisationType: fields.get("organisationType"),
        region: fields.get("region"),
        studentCount: fields.get("studentCount"),
        contactName: fields.get("contactName"),
        email: fields.get("email"),
        phone: fields.get("phone"),
        preferredContact: fields.get("preferredContact"),
        trialRequested: fields.get("trialRequested") === "on",
        importHelp: fields.get("importHelp"),
        dataFormat: fields.get("dataFormat"),
        academicYears: fields.get("academicYears"),
        importScope: fields.getAll("importScope"),
        retentionAcknowledged: fields.get("retentionAcknowledged") === "on",
        message: fields.get("message"),
        website: fields.get("website"),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Error(data.error || "The request could not be sent.");
    form.reset();
    form.classList.remove("was-validated");
    success.textContent = data.message ||
      (fields.get("onboardingMode") === "self_service"
        ? "Your workspace request has been received. Check your email for the secure activation link."
        : "Your assisted onboarding request has been received. Elegant Empire AI will contact you after reviewing the details.");
    success.hidden = false;
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
    button.textContent = "Continue with onboarding";
  }
});
