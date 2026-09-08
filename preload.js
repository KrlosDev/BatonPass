const { contextBridge, ipcRenderer } = require('electron');

// One bridge for both windows. The widget uses the usage half, the settings
// flyout the preferences half; neither is harmed by seeing the other.
function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('batonPass', {
  // The window corner radius is system-drawn and differs per platform, so the
  // stylesheet has to know where it's running to match it.
  platform: process.platform,

  onUpdate: subscribe('usage:update'),
  onAccent: subscribe('accent:update'),
  onHandoff: subscribe('handoff:update'),

  refresh: () => ipcRenderer.invoke('usage:refresh'),
  fitWindow: (contentHeight) => ipcRenderer.invoke('window:fit', contentHeight),

  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  previewAccent: (hex) => ipcRenderer.invoke('prefs:preview-accent', hex),
  setAccent: (hex) => ipcRenderer.invoke('prefs:set-accent', hex),
  setTerminal: (choice) => ipcRenderer.invoke('prefs:set-terminal', choice),

  hideSettings: () => ipcRenderer.invoke('settings:hide'),
  // Holds the flyout open across a focus loss the user caused on purpose.
  pinSettings: (pinned) => ipcRenderer.invoke('settings:pin', pinned),

  getStartup: () => ipcRenderer.invoke('startup:get'),
  setStartup: (enabled) => ipcRenderer.invoke('startup:set', enabled),

  // Returns the job's state as it stands; the rest arrives on onHandoff.
  startHandoff: (sessionId) => ipcRenderer.invoke('handoff:start', sessionId),
  listHandoffs: () => ipcRenderer.invoke('handoff:list'),
  reopenSession: (sessionId) => ipcRenderer.invoke('session:reopen', sessionId),
  onDeleteConfirmSetup: subscribe('delete-confirm:setup'),
  confirmDelete: (confirmed) => ipcRenderer.send('delete-confirm:result', confirmed),
  // Confirms in main before doing anything; resolves { cancelled: true } if the
  // user backs out.
  deleteSession: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
});
