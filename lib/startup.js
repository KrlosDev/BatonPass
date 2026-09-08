const path = require('path');
const { app } = require('electron');

const SUPPORTED = process.platform === 'win32' || process.platform === 'darwin';

function loginItemOptions() {
  if (process.platform !== 'win32') return {};
  return {
    path: process.execPath,
    args: app.isPackaged ? [] : [path.resolve(app.getAppPath())],
  };
}

function isEnabled() {
  if (!SUPPORTED) return false;
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

function setEnabled(enabled) {
  if (!SUPPORTED) return false;
  app.setLoginItemSettings({
    ...loginItemOptions(),
    openAtLogin: !!enabled,
    // macOS only. Harmless here since the widget draws itself anyway, but it
    // keeps the app out of the login-time window restore.
    openAsHidden: !!enabled,
  });
  return isEnabled();
}

module.exports = { SUPPORTED, isEnabled, setEnabled };
