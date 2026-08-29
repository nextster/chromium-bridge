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

  const extension = status.extension;
  if (!extension.privacy?.consented || !extension.permissions?.siteAccess || !extension.permissions?.tabs) {
    return "Approve local browser access in the Chromium Bridge onboarding page.";
  }
  if (!extension.userScriptsAvailable) {
    return "Open extension details and enable Allow User Scripts.";
  }
  return "Browser and Codex bridge are ready.";
}
