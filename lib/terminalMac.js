// The macOS half of lib/terminal.js, with identical contracts so callers never
// branch. Terminals are driven by Apple events, since a GUI app can't spawn one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const core = require('./terminal');
const { childEnv } = require('./claudeCli');

// Named outright, so nothing here depends on the GUI process's minimal PATH.
const PS = '/bin/ps';
const OSASCRIPT = '/usr/bin/osascript';

// Same ceiling as the Windows walk: past this we've left the terminal behind.
const MAX_ANCESTOR_DEPTH = 12;

// First match wins, walking up by ppid from claude. Matched on the app bundle in
// the full command line, not on a truncated process name.
const HOST_IMAGES = [
  { match: /\/iTerm\.app\//, kind: 'iterm2' },
  { match: /\/Terminal\.app\//, kind: 'terminal' },
  { match: /(\/Code Helper|Visual Studio Code\.app|\/VSCodium\.app\/|\/Code\.app\/)/, kind: 'vscode' },
];

// Reaching one of these means the walk has left userland terminals entirely.
const WALK_STOPS = /(^|\/)(launchd|loginwindow)(\s|$)/;

function tidy(message) {
  return String(message || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .slice(0, 200);
}

// ps and AppleScript spell a tty differently, so both are normalised to the bare
// `ttys002` form. `??` means no controlling terminal, so it matches no window.
function normalizeTty(tty) {
  if (!tty) return null;
  let t = String(tty).trim().replace(/^\/dev\//, '');
  if (t === '??' || t === '?' || t === '-') return null;
  if (/^s\d+$/.test(t)) t = `tty${t}`; // s002 -> ttys002
  return t;
}

// The whole process table in one ps round-trip, keyed by pid. `command`, not the
// truncated `comm`, so app-bundle paths survive for HOST_IMAGES to match.
function processTable() {
  let raw;
  try {
    raw = execFileSync(PS, ['-axww', '-o', 'pid=,ppid=,tty=,command='], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return new Map();
  }

  const table = new Map();
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    table.set(pid, {
      pid,
      ppid: Number(m[2]),
      tty: normalizeTty(m[3]),
      command: m[4],
    });
  }
  return table;
}

// macOS reuses pids, so one is only trusted once its command line shows claude.
// A node-based dev install won't match, which loses detection but kills nothing.
function isClaude(command) {
  const exe = String(command || '').trim().split(/\s+/)[0] || '';
  return path.basename(exe) === 'claude';
}

// The terminal a session runs in, or null. `pid` is the host, `shellPid` the
// process below it whose death closes one tab, `tty` the session's terminal.
function detectHost(sessionId, table = processTable()) {
  const record = core.readSessionRegistry().get(sessionId);
  if (!record || typeof record.pid !== 'number') return null;

  const start = table.get(record.pid);
  if (!start || !isClaude(start.command)) return null;

  const tty = start.tty;
  let current = start;
  let lastBelowHost = current;
  for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (depth > 0) {
      if (WALK_STOPS.test(current.command)) break;
      const host = HOST_IMAGES.find((entry) => entry.match.test(current.command));
      if (host) {
        return {
          kind: host.kind,
          pid: current.pid,
          shellPid: lastBelowHost ? lastBelowHost.pid : record.pid,
          tty,
        };
      }
      lastBelowHost = current;
    }
    current = current.ppid == null ? null : table.get(current.ppid);
  }
  return null;
}

// The outer of two layers: the caller shell-quotes the command, and this makes
// it an AppleScript string literal. Backslash before quote, so order matters.
function escapeForAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function asStr(value) {
  return `"${escapeForAppleScript(value)}"`;
}

// Runs an AppleScript given as a list of lines; a denied Automation prompt
// (-1743) becomes an instruction the user can act on.
function runOsascript(lines) {
  return new Promise((resolve) => {
    const args = lines.flatMap((line) => ['-e', line]);
    execFile(OSASCRIPT, args, { timeout: 20000, env: childEnv() }, (error, _stdout, stderr) => {
      if (!error) return resolve({ ok: true });
      const text = String(stderr || error.message || '');
      if (/-1743|not authorized/i.test(text)) {
        return resolve({
          ok: false,
          error:
            'macOS blocked BatonPass from controlling the terminal. Allow it under ' +
            'System Settings > Privacy & Security > Automation.',
        });
      }
      resolve({ ok: false, error: tidy(text) || 'osascript failed' });
    });
  });
}

function itermInstalled() {
  return ['/Applications/iTerm.app', path.join(os.homedir(), 'Applications', 'iTerm.app')].some(
    (candidate) => {
      try {
        fs.accessSync(candidate);
        return true;
      } catch {
        return false;
      }
    }
  );
}

// A bare `do script` opens a NEW Terminal window; the shell stays at a prompt
// when claude exits, as if the command had been typed by hand.
function launchTerminal(command) {
  return runOsascript([
    'tell application "Terminal"',
    'activate',
    `do script ${asStr(command)}`,
    'end tell',
  ]);
}

// iTerm's dictionary differs: make a window, then write the command into its
// session (write text runs it, newline included).
function launchIterm(command) {
  return runOsascript([
    'tell application "iTerm"',
    'activate',
    'set theWindow to (create window with default profile)',
    `tell current session of theWindow to write text ${asStr(command)}`,
    'end tell',
  ]);
}

// Opens `exe args...` in a new visible terminal at cwd. Terminal.app is the
// guaranteed base; iTerm is reached only when both preferred and installed.
async function openTerminal({ cwd, exe, args = [], prefer = null }) {
  const command = `cd ${core.shellQuote(cwd)} && ${[exe, ...args].map(core.shellQuote).join(' ')}`;

  const tiers = [];
  if (prefer === 'iterm2' && itermInstalled()) tiers.push({ kind: 'iterm2', run: launchIterm });
  tiers.push({ kind: 'terminal', run: launchTerminal });

  const failures = [];
  for (const tier of tiers) {
    const result = await tier.run(command);
    if (result.ok) return { ok: true, via: tier.kind };
    failures.push(`${tier.kind}: ${result.error}`);
  }
  return { ok: false, via: null, error: failures.join('; ') || 'no terminal available' };
}

// The Mac analog of terminal.availableTerminals: 'auto' and 'terminal' always,
// iTerm2 only when installed - the same check openTerminal's tier uses.
function availableTerminals() {
  const out = ['auto', 'terminal'];
  if (itermInstalled()) out.push('iterm2');
  return out;
}

// The macOS killBoundary: one process hosts every Terminal/iTerm window, so the
// boundary is the shell below it - otherwise the session itself.
function killBoundary(record, host, closeWindow) {
  if (!closeWindow || !host) return { pid: record.pid, closes: 'session' };
  if (host.kind === 'terminal' || host.kind === 'iterm2') {
    return { pid: host.shellPid || record.pid, closes: 'tab' };
  }
  return { pid: record.pid, closes: 'session' };
}

// pid -> [child pids], from a process-table snapshot.
function childrenByPpid(table) {
  const kids = new Map();
  for (const proc of table.values()) {
    if (proc.ppid == null) continue;
    if (!kids.has(proc.ppid)) kids.set(proc.ppid, []);
    kids.get(proc.ppid).push(proc.pid);
  }
  return kids;
}

// SIGKILLs a pid and every descendant, children first. Killing only the shell
// would reparent claude to launchd and leave it running headless.
function killTree(table, rootPid) {
  const kids = childrenByPpid(table);
  const order = [];
  const walk = (pid) => {
    for (const child of kids.get(pid) || []) walk(child);
    order.push(pid);
  };
  walk(rootPid);
  for (const pid of order) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, or not ours to signal.
    }
  }
}

// Closes the one window/tab whose tty matches, best effort. iTerm can close a
// tab; Terminal only closes a whole window, so only when it holds that one tab.
function closeWindowByTty(kind, tty) {
  const dev = `/dev/${tty}`;
  const lines =
    kind === 'iterm2'
      ? [
          'tell application "iTerm"',
          'repeat with w in windows',
          'repeat with t in tabs of w',
          'repeat with s in sessions of t',
          `if (tty of s) is ${asStr(dev)} then close t`,
          'end repeat',
          'end repeat',
          'end repeat',
          'end tell',
        ]
      : [
          'tell application "Terminal"',
          'repeat with w in windows',
          `if (count of tabs of w) is 1 and (tty of tab 1 of w) is ${asStr(dev)} then close w saving no`,
          'end repeat',
          'end tell',
        ];
  try {
    execFileSync(OSASCRIPT, lines.flatMap((line) => ['-e', line]), {
      timeout: 15000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// Stops a session; with closeWindow, also closes its terminal where that takes
// nothing else down. Synchronous, so the handoff orchestrator reads it directly.
function killSession(sessionId, { closeWindow = false, dryRun = false } = {}) {
  const record = core.readSessionRegistry().get(sessionId);
  if (!record || typeof record.pid !== 'number') {
    return { killed: false, reason: 'no running process found' };
  }

  const table = processTable();
  const proc = table.get(record.pid);
  if (!proc || !isClaude(proc.command)) {
    return { killed: false, reason: 'no running process found' };
  }

  const host = closeWindow ? detectHost(sessionId, table) : null;
  const boundary = killBoundary(record, host, closeWindow);

  if (dryRun) {
    return { killed: false, dryRun: true, boundary, host, reason: 'dry run' };
  }

  // 1. Stop the work first, so only the shell is left for the scripted close.
  killTree(table, record.pid);

  // 2. Close the exact window/tab, best effort. Only for a host we can address.
  let windowClosed = false;
  if (closeWindow && host && host.tty && (host.kind === 'terminal' || host.kind === 'iterm2')) {
    windowClosed = closeWindowByTty(host.kind, host.tty);
  }

  // 3. Backstop: take the shell down too, in case the close did nothing.
  if (boundary.pid !== record.pid) killTree(table, boundary.pid);

  return {
    killed: true,
    pid: boundary.pid,
    closes: boundary.closes,
    host: host && host.kind,
    windowClosed,
  };
}

module.exports = {
  detectHost,
  openTerminal,
  availableTerminals,
  killSession,
  killBoundary,
  isClaude,
  normalizeTty,
  escapeForAppleScript,
  processTable,
};
