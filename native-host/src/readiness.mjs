export const READY_MESSAGE = "Chromium Bridge is ready.";
export const INSTALL_MESSAGE = "Install the Chromium Bridge extension in your browser and keep the browser open.";
export const CONSENT_MESSAGE = "Approve local browser access in the Chromium Bridge popup.";
export const USER_SCRIPTS_MESSAGE = "Open the extension details and enable Allow User Scripts.";

// Maps the extension's ping response to the one thing the user still has to do.
export function readinessStep(extension) {
  if (!extension?.pong) return { ready: false, message: INSTALL_MESSAGE };
  if (!extension.privacy?.consented || !extension.permissions?.siteAccess || !extension.permissions?.tabs) {
    return { ready: false, message: CONSENT_MESSAGE };
  }
  if (!extension.userScriptsAvailable) return { ready: false, message: USER_SCRIPTS_MESSAGE };
  return { ready: true, message: READY_MESSAGE };
}
