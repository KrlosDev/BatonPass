const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, screen, Notification } = require('electron');
const path = require('path');
const { getActiveSessions } = require('./lib/sessions');
const blurBehind = require('./lib/blurBehind');
const startup = require('./lib/startup');
const store = require('./lib/store');
const handoff = require('./lib/handoff');
const handoffPrompt = require('./lib/handoffPrompt');
const sessionFiles = require('./lib/sessionFiles');
const terminal = require('./lib/terminal');
const terminalMemory = require('./lib/terminalMemory');

const POLL_INTERVAL_MS = 5 * 1000; // local file reads only, safe to poll often
const WIDGET_WIDTH = 380;
const WIDGET_MAX_HEIGHT = 630;
const WIDGET_MIN_HEIGHT = 90;

// Narrow enough to read in one line of sight; the height follows the copy,
// which grows with the chat's name and project path.
const DELETE_CONFIRM_WIDTH = 400;
const DELETE_CONFIRM_MIN_HEIGHT = 150;
const DELETE_CONFIRM_MAX_HEIGHT = 420;

const SETTINGS_WIDTH = 340;
const SETTINGS_MAX_HEIGHT = 650;
const SETTINGS_MIN_HEIGHT = 120;

// Ascending, so the highest one a chat has passed is the newest to announce.
const CONTEXT_THRESHOLDS = [40, 60, 80, 100];

let tray = null;
let widgetWindow = null;
let settingsWindow = null;
let deleteConfirmWindow = null;
let deleteConfirmResolver = null;
let deleteConfirmArea = null;
let pollTimer = null;
let lastSessions = [];

// sessionId -> highest threshold already announced, so each level fires once
// and a chat that keeps filling doesn't re-notify on every 20s poll.
const notifiedThresholds = new Map();

let settingsPinned = false;

// Both windows are frameless and system-tinted; only their size, placement and
// dismissal differ.
function frostedWindowOptions() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  return {
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,

    // Alpha here is what lets whatever is behind show through instead of a
    // solid fill.
    backgroundColor: '#00000000',
    roundedCorners: true,

    ...(isMac && {
      transparent: true,
      vibrancy: 'under-window',
      visualEffectState: 'active',
    }),

    ...(isWin && {
      transparent: true,
    }),

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

// DWM blurs what's behind the window and rounds it so the blur stops at the
// corners. Tint is left to CSS, which can follow the light/dark theme.
function applyBlurBehind(win) {
  if (!blurBehind.SUPPORTED) return;
  blurBehind.enableBlur(win);
  blurBehind.roundCorners(win);
}

function createWidget() {
  widgetWindow = new BrowserWindow({
    ...frostedWindowOptions(),
    width: WIDGET_WIDTH,
    height: WIDGET_MAX_HEIGHT,
    show: false,
    // Never above other windows: it's a desktop widget, not an overlay.
    // skipTaskbar keeps it out of the taskbar and alt-tab as well.
    alwaysOnTop: false,
  });

  applyBlurBehind(widgetWindow);
  widgetWindow.loadFile(path.join(__dirname, 'renderer', 'widget.html'));

  // The first poll's send is lost if the renderer hasn't subscribed yet, which
  // would leave the panel on "Loading..." until the next 20s tick.
  widgetWindow.webContents.on('did-finish-load', () => {
    if (lastSessions.length) {
      widgetWindow.webContents.send('usage:update', { ok: true, sessions: lastSessions });
    }
  });

  // A tray flyout: it re-anchors to the tray each time it opens and hides the
  // moment it loses focus, so there's no free-floating position to remember.
  widgetWindow.on('blur', () => widgetWindow.hide());
}

function createSettings() {
  settingsWindow = new BrowserWindow({
    ...frostedWindowOptions(),
    width: SETTINGS_WIDTH,
    height: SETTINGS_MAX_HEIGHT,
    show: false,
  });

  applyBlurBehind(settingsWindow);
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));

  settingsWindow.on('blur', () => {
    if (!settingsPinned) settingsWindow.hide();
  });
}

function positionNearTray(win, trayBounds) {
  const display = screen.getDisplayMatching(trayBounds);
  const { x: waX, y: waY, width: waW, height: waH } = display.workArea;
  const winBounds = win.getBounds();

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  const y =
    process.platform === 'darwin'
      ? Math.round(trayBounds.y + trayBounds.height + 4)
      : Math.round(trayBounds.y - winBounds.height - 4);

  x = Math.min(Math.max(x, waX), waX + waW - winBounds.width);
  const clampedY = Math.min(Math.max(y, waY), waY + waH - winBounds.height);

  win.setBounds({ x, y: clampedY, width: winBounds.width, height: winBounds.height });
}

function showSettings() {
  if (!settingsWindow) createSettings();
  positionNearTray(settingsWindow, tray.getBounds());
  settingsWindow.show();
  settingsWindow.focus();
}

function showWidget() {
  if (!widgetWindow) createWidget();
  positionNearTray(widgetWindow, tray.getBounds());
  widgetWindow.show();
  widgetWindow.focus();
}

function showDeleteConfirm(sessionId) {
  const entry = handoff.handovers()[sessionId];
  const session = lastSessions.find((row) => row.sessionId === sessionId);
  const title = (entry && entry.title) || (session && session.title) || sessionId.slice(0, 8);
  const project = (entry && entry.project) || (session && session.project) || '';
  const count = sessionFiles.countFiles(sessionFiles.findSessionFiles(sessionId));

  if (deleteConfirmWindow && !deleteConfirmWindow.isDestroyed()) {
    deleteConfirmWindow.focus();
    return Promise.resolve({ ok: false, cancelled: true });
  }

  return new Promise((resolve) => {
    deleteConfirmResolver = resolve;

    const centerDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = centerDisplay.workArea;

    deleteConfirmWindow = new BrowserWindow({
      ...frostedWindowOptions(),
      width: DELETE_CONFIRM_WIDTH,
      height: DELETE_CONFIRM_MIN_HEIGHT,
      show: false,
      minimizable: false,
      maximizable: false,
      // A confirmation the user can lose behind another window is worse than
      // no confirmation: the delete they asked for just never happens.
      alwaysOnTop: true,
    });

    // Kept for the whole life of the window so the fit handler can re-centre
    // on the display the dialog was opened on, not wherever the cursor went.
    deleteConfirmArea = { x, y, width, height };
    applyBlurBehind(deleteConfirmWindow);

    deleteConfirmWindow.loadFile(path.join(__dirname, 'renderer', 'delete-confirm.html'));
    deleteConfirmWindow.once('ready-to-show', () => {
      centerDeleteConfirm();
      deleteConfirmWindow.webContents.send('delete-confirm:setup', {
        title,
        project,
        count,
      });
      deleteConfirmWindow.show();
      deleteConfirmWindow.focus();
    });

    deleteConfirmWindow.on('closed', () => {
      deleteConfirmWindow = null;
      deleteConfirmArea = null;
    });

    ipcMain.once('delete-confirm:result', (_event, confirmed) => {
      if (!deleteConfirmWindow || deleteConfirmWindow.isDestroyed()) {
        resolve({ ok: false, cancelled: true });
        return;
      }

      deleteConfirmWindow.close();
      if (!confirmed) {
        resolve({ ok: false, cancelled: true });
        return;
      }

      const result = handoff.remove(sessionId);
      refreshUsage();
      resolve(result);
    });
  });
}

function toggleWidget() {
  if (widgetWindow && widgetWindow.isVisible()) {
    widgetWindow.hide();
    return;
  }
  showWidget();
}

// Called before and after the window is sized to its copy, so the dialog ends
// up centred at its final height rather than low by half of what it grew by.
function centerDeleteConfirm() {
  if (!deleteConfirmWindow || deleteConfirmWindow.isDestroyed() || !deleteConfirmArea) return;
  const { x, y, width, height } = deleteConfirmArea;
  const [winWidth, winHeight] = deleteConfirmWindow.getSize();
  deleteConfirmWindow.setPosition(
    Math.round(x + (width - winWidth) / 2),
    Math.round(y + (height - winHeight) / 2)
  );
}

function fitToContent(win, contentHeight, min, max) {
  const height = Math.round(Math.min(max, Math.max(min, contentHeight)));
  const [width] = win.getContentSize();
  win.setContentSize(width, height);
}

function eachWindow(callback) {
  for (const win of [widgetWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) callback(win);
  }
}

function broadcastAccent(accent) {
  eachWindow((win) => win.webContents.send('accent:update', accent));
}

// The fullest chat, not the most recent one: the tooltip answers "is anything
// about to run out of room".
function updateTrayTooltip(sessions) {
  if (!tray) return;
  if (!sessions || sessions.length === 0) {
    tray.setToolTip('BatonPass - no active chats');
    return;
  }
  const fullest = sessions.reduce((a, b) => (b.pct > a.pct ? b : a));
  tray.setToolTip(`${fullest.title} - ${fullest.pct}% of context`);
}

function sendToWidget(channel, payload) {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send(channel, payload);
  }
}

// Job state rides its own channel: getActiveSessions() hands back cached row
// objects, so decorating them would leave stale handoff state in that cache.
function pushHandoff(state) {
  sendToWidget('handoff:update', state);
}

// Writes the prompt out once as a real command, so /handoff can be typed by
// hand. Flagged rather than re-checked, so a deliberate deletion stays deleted.
function installHandoffCommand() {
  if (store.load().handoffCommandInstalled) return;
  const result = handoffPrompt.installCommand();
  if (result.installed) console.log('[handoff] installed command at', result.path);
  store.save({ handoffCommandInstalled: true });
}

// Detection needs a live process tree, so a chat's terminal is learned while it
// still runs. One chat at a time, deferred, and never looked up twice.
function learnTerminals(sessions) {
  const pending = sessions.filter(
    (session) => session.live && !terminalMemory.recall(session.sessionId)
  );
  if (pending.length === 0) return;

  setTimeout(() => {
    const session = pending[0];
    try {
      const host = terminal.detectHost(session.sessionId);
      if (host) terminalMemory.remember(session.sessionId, { kind: host.kind, cwd: session.cwd });
    } catch (error) {
      console.error('[learnTerminals]', error.message);
    }
  }, 0);
}

// One notification per chat per level, fired only on the way up. The map holds
// the highest level already announced, so a chat sitting at 85% won't re-notify
// every poll, while one that climbs from 60% to 80% announces the 80% crossing.
function notifyThresholdCrossings(sessions) {
  if (!Notification.isSupported()) return;

  // A chat that dropped off the list (handed over, forked away, or gone quiet)
  // is re-armed: if it comes back it should be able to announce again.
  const liveIds = new Set(sessions.map((session) => session.sessionId));
  for (const id of notifiedThresholds.keys()) {
    if (!liveIds.has(id)) notifiedThresholds.delete(id);
  }

  for (const session of sessions) {
    const crossed = CONTEXT_THRESHOLDS.filter((level) => session.pct >= level);
    if (crossed.length === 0) continue;

    const highest = crossed[crossed.length - 1];
    const alreadyNotified = notifiedThresholds.get(session.sessionId) || 0;
    if (highest <= alreadyNotified) continue;

    notifiedThresholds.set(session.sessionId, highest);
    const body =
      highest >= 100
        ? 'Context window is full. Hand off to a fresh session.'
        : 'Context is filling up. Consider handing off to a fresh session.';
    const notification = new Notification({
      title: `${session.title} - ${highest}% full`,
      body,
    });
    notification.on('click', showWidget);
    notification.show();
  }
}

function refreshUsage() {
  try {
    // A fork is a means to an end, not a chat the user started, so it stays off
    // the list even if the CLI persists it.
    const forks = handoff.forkSessionIds();
    const all = getActiveSessions().filter((session) => !forks.has(session.sessionId));
    // Reconcile before filtering: a handed-over chat that has been used since is
    // no longer handed over, and belongs back in this list.
    const handedOver = handoff.reconcile(all);
    // `live` says whether the chat still has a process behind it; a listed row
    // that isn't live is one whose terminal was closed, so it gets a reopen button.
    const sessions = all
      .filter((session) => !handedOver[session.sessionId])
      .map((session) => ({
        ...session,
        live: terminal.isLive(session.sessionId),
        terminalKind: (terminalMemory.recall(session.sessionId) || {}).kind || null,
      }));
    lastSessions = sessions;
    notifyThresholdCrossings(sessions);
    learnTerminals(sessions);
    updateTrayTooltip(sessions);
    // The handed-over list rides along with the poll, so the other tab stays
    // correct even when the index changed outside this window.
    sendToWidget('usage:update', { ok: true, sessions, handovers: handedOver });
    return sessions;
  } catch (error) {
    console.error('[refreshUsage]', error);
    sendToWidget('usage:update', { ok: false, error: error.message });
    return null;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshUsage, POLL_INTERVAL_MS);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Settings', click: showSettings },
    { label: 'Refresh now', click: refreshUsage },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function trayIconPath() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray-icon.png';
  return path.join(__dirname, 'assets', file);
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();

  // Without this, Windows attributes notifications to the default Electron host
  // instead of BatonPass, showing the wrong name and icon in the toast.
  app.setAppUserModelId('dev.krlosdev.batonpass');

  installHandoffCommand();

  const dropped = store.pruneLegacyKeys();
  if (dropped.length > 0) console.log('[store] dropped stale settings:', dropped.join(', '));

  // Not resized: createFromPath picks up the @2x file as a second representation,
  // and resizing collapses them into one bitmap, losing the retina variant.
  tray = new Tray(nativeImage.createFromPath(trayIconPath()));
  tray.setToolTip('BatonPass - chat context');
  tray.on('click', toggleWidget);

  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));

  createWidget();
  createSettings();
  startPolling();
  refreshUsage();

  ipcMain.handle('usage:refresh', refreshUsage);
  ipcMain.handle('settings:hide', () => {
    if (settingsWindow) settingsWindow.hide();
  });
  ipcMain.handle('settings:pin', (_event, pinned) => {
    settingsPinned = !!pinned;
  });

  ipcMain.handle('prefs:get', () => ({
    accent: store.loadAccent(),
    defaultAccent: store.DEFAULTS.accentColor,
    // Only offered where a terminal can actually be opened; elsewhere the
    // settings panel hides the control rather than showing a dead choice.
    terminal: store.loadTerminal(),
    // Only the terminals actually installed, so the menu never offers one that
    // isn't there; settings surfaces a stored choice since uninstalled.
    terminalChoices: terminal.availableTerminals(),
  }));
  // Unsaved, for the live drag inside the colour picker: the widget is a
  // separate window, so without this it wouldn't repaint until you committed.
  ipcMain.handle('prefs:preview-accent', (_event, hex) => {
    if (store.isHexColor(hex)) broadcastAccent(hex);
  });
  ipcMain.handle('prefs:set-accent', (_event, hex) => {
    const accent = store.setAccent(hex);
    broadcastAccent(accent);
    return accent;
  });
  // Echoes back what was stored, so a value the store rejected leaves the
  // dropdown showing the truth rather than the attempt.
  ipcMain.handle('prefs:set-terminal', (_event, choice) => store.setTerminal(choice));

  ipcMain.handle('window:fit', (event, contentHeight) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === widgetWindow) {
      fitToContent(win, contentHeight, WIDGET_MIN_HEIGHT, WIDGET_MAX_HEIGHT);
      // The flyout hangs off the tray, so its top edge moves as the height grows.
      if (tray) positionNearTray(widgetWindow, tray.getBounds());
    } else if (win === settingsWindow) {
      fitToContent(win, contentHeight, SETTINGS_MIN_HEIGHT, SETTINGS_MAX_HEIGHT);
      // The flyout hangs above the tray on Windows, so its top edge moves
      // whenever the height changes.
      if (tray) positionNearTray(settingsWindow, tray.getBounds());
    } else if (win === deleteConfirmWindow) {
      fitToContent(win, contentHeight, DELETE_CONFIRM_MIN_HEIGHT, DELETE_CONFIRM_MAX_HEIGHT);
      centerDeleteConfirm();
    }
  });

  ipcMain.handle('startup:get', () => ({
    supported: startup.SUPPORTED,
    enabled: startup.isEnabled(),
  }));
  // Returns what the OS actually reports afterwards, not what was asked for,
  // so a refused write shows up in the checkbox instead of passing silently.
  ipcMain.handle('startup:set', (_event, enabled) => startup.setEnabled(enabled));

  // Returns the job's current state immediately rather than awaiting the 30-90s
  // run, which would leave the invoke pending across a widget reload.
  ipcMain.handle('handoff:start', (_event, sessionId) => {
    const session = lastSessions.find((row) => row.sessionId === sessionId);
    if (!session) {
      return { sessionId, status: 'failed', message: 'That chat is no longer on the list.' };
    }
    return handoff.start(session, pushHandoff);
  });
  ipcMain.handle('handoff:list', () => handoff.list());

  // Serves both tabs. The row is passed through so a chat with no handover
  // record and no remembered terminal still knows which folder to open in.
  ipcMain.handle('session:reopen', async (_event, sessionId) => {
    const session = lastSessions.find((row) => row.sessionId === sessionId) || null;
    const result = await handoff.reopen(sessionId, session);
    refreshUsage();
    return result;
  });

  // The destructive action is gated behind a custom centered modal so it keeps
  // the app's frosted styling while still showing in the middle of the screen.
  ipcMain.handle('session:delete', async (_event, sessionId) => {
    return showDeleteConfirm(sessionId);
  });
});

app.on('before-quit', () => handoff.cancelAll());

app.on('window-all-closed', (event) => event.preventDefault());
