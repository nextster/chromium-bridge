import { READY_MESSAGE, readinessStep } from "../native-host/src/readiness.mjs";

export const READY_STEP = READY_MESSAGE;

export function bridgeKind(status, storeExtensionId, developmentExtensionId) {
  const id = status?.host?.extension?.id || "";
  if (!status?.extension?.pong || !id) return "missing";
  if (id === storeExtensionId) return "store";
  if (id === developmentExtensionId) return "development";
  return "other";
}

// Everything the user still has to do in the browser, from one status probe.
export function storeNextSteps(status, storeExtensionId, developmentExtensionId, storeUrl) {
  const kind = bridgeKind(status, storeExtensionId, developmentExtensionId);
  const extension = status?.extension;
  const steps = [];
  if (kind === "development") {
    steps.push(`Remove the unpacked development extension, then install Chromium Bridge from ${storeUrl}`);
  } else if (kind === "other") {
    steps.push(`Disable the conflicting Chromium Bridge extension, then install Chromium Bridge from ${storeUrl}`);
  } else if (kind === "missing") {
    steps.push(`Install Chromium Bridge from ${storeUrl}`);
  }
  const connected = kind === "store";
  if (!connected || !extension.privacy?.consented || !extension.permissions?.siteAccess || !extension.permissions?.tabs) {
    steps.push("Approve local browser access in the onboarding page");
  }
  if (!connected || !extension.userScriptsAvailable) {
    steps.push("Enable Allow User Scripts in the extension details");
  }
  return steps;
}

export function storeReadinessStep(status, storeExtensionId, developmentExtensionId) {
  switch (bridgeKind(status, storeExtensionId, developmentExtensionId)) {
    case "development":
      return "Removing the unpacked development extension.";
    case "other":
      return "Disable the conflicting Chromium Bridge extension, then install the Store version.";
    case "missing":
      return "Install the extension from the Store page.";
  }

  return readinessStep(status.extension).message;
}
