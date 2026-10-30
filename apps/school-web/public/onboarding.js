const form = document.querySelector("#onboarding-request-form");
const error = document.querySelector("#onboarding-error");
const success = document.querySelector("#onboarding-success");

function showNextSteps(data, mode) {
  const title = document.createElement("h3");
  const message = document.createElement("p");
  const steps = document.createElement("ol");
  const link = document.createElement("a");
  const active = data.nextStep === "sign_in";

  title.textContent = active
    ? "Your school is already onboarded"
    : mode === "assisted"
      ? "Your onboarding request was received"
      : "Your school onboarding has started";
  message.textContent =
    data.message ||
    data.error ||
    (active
      ? "Please sign in to continue to your school workspace."
      : "Check the administrator email for the secure activation link.");

  const stepText = active
    ? [
        "Select Sign in below.",
        "Use the administrator email connected to the school.",
        "Continue managing students, fees, attendance and results.",
      ]
    : mode === "assisted"
      ? [
          "Elegant Empire AI will review the school details.",
          "We will contact the preferred contact person.",
          "Do not submit another onboarding request.",
        ]
      : [
          "Open the administrator email inbox and check the spam folder.",
          "Select the secure activation link in the email.",
          "Create or sign in to the administrator account.",
          "Complete the school settings, then add or import school records.",
        ];
  for (const text of stepText) {
    const item = document.createElement("li");
    item.textContent = text;
    steps.append(item);
  }

  link.className = "button";
  link.href = active ? "/" : "mailto:contact@elegantempireai.com";
  link.textContent = active ? "Sign in to the school portal" : "Contact support";

  success.replaceChildren(title, message, steps, link);
  success.hidden = false;
  for (const child of form.children) {
    if (child !== success) child.hidden = true;
  }
  success.scrollIntoView({ behavior: "smooth", block: "start" });
}

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
    const mode = fields.get("onboardingMode");
    if (
      !response.ok &&
      !(response.status === 409 && data.code === "school_already_onboarded")
    )
      throw Error(data.error || "The request could not be sent.");
    form.reset();
    form.classList.remove("was-validated");
    showNextSteps(data, mode);
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
    button.textContent = "Continue with onboarding";
  }
});
