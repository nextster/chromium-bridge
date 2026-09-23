import { READY_MESSAGE, readinessStep } from "../native-host/src/readiness.mjs";

export const READY_STEP = READY_MESSAGE;

export function bridgeKind(status, storeExtensionId, developmentExtensionId) {
  const id = status?.host?.extension?.id || "";
  if (!status?.extension?.pong || !id) return "missing";
  if (id === storeExtensionId) return "store";
  if (id === developmentExtensionId) return "development";
  return "other";
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
