export async function scheduleDevelopmentUninstall(management, schedule = setTimeout) {
  const self = await management.getSelf();
  if (self.installType !== "development") {
    return { uninstalling: false, id: self.id, installType: self.installType };
  }

  schedule(() => {
    void management.uninstallSelf({ showConfirmDialog: false }).catch(() => {});
  }, 250);
  return { uninstalling: true, id: self.id, installType: self.installType };
}
