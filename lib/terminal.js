// Opening a visible terminal from a process that has no console, and stopping a
// session running in one. Detection is best-effort; every caller handles null.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { childEnv } = require('./claudeCli');

// On darwin, detectHost / openTerminal / killSession delegate to ./terminalMac,
// required lazily inside them so Windows never loads it and no cycle forms.
const IS_MAC = process.platform === 'darwin';
const SUPPORTED = process.platform === 'win32' || IS_MAC;

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

// How long a launched terminal has to fail before we accept that it worked; for
// wt.exe a fast clean exit is success, not silence.
const LAUNCH_GRACE_MS = 5000;

// Walking further than this means we've left the terminal behind and are up in
// the service tree; nothing above here is a host we could launch into.
const MAX_ANCESTOR_DEPTH = 12;

// First match wins, walking up from claude. OpenConsole.exe is left out: it
// appears under both Windows Terminal and VS Code, so its parent decides.
const HOST_IMAGES = [
  { match: /^WindowsTerminal\.exe$/i, kind: 'windows-terminal' },
  { match: /^Code\.exe$/i, kind: 'vscode' },
  { match: /^mintty\.exe$/i, kind: 'git-bash' },
  { match: /^git-bash\.exe$/i, kind: 'git-bash' },
  { match: /^conhost\.exe$/i, kind: 'conhost' },
];

// Reaching one of these means the walk has left userland terminals entirely.
const WALK_STOPS = /^(explorer\.exe|services\.exe|wininit\.exe|winlogon\.exe)$/i;

// One PowerShell round-trip for the whole process table. Creation time is
// stringified there: a FILETIME loses its low digits as a JSON number.
function processTable() {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, " +
    "@{n='FileTime';e={ if ($_.CreationDate) { [string]$_.CreationDate.ToFileTime() } else { '' } }} " +
    '| ConvertTo-Json -Compress';

  let raw;
  try {
    raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }
    );
  } catch {
    return new Map();
  }

  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!Array.isArray(rows)) rows = [rows];

  const table = new Map();
  for (const row of rows) {
    if (!row || typeof row.ProcessId !== 'number') continue;
    table.set(row.ProcessId, {
      pid: row.ProcessId,
      ppid: typeof row.ParentProcessId === 'number' ? row.ParentProcessId : null,
      name: row.Name || '',
      exePath: row.ExecutablePath || '',
      fileTime: row.FileTime || '',
    });
  }
  return table;
}

// Every session Claude Code has open, keyed by session id. A record here means
// the session was running once, not that it is running now.
function readSessionRegistry() {
  const out = new Map();
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (record && record.sessionId && typeof record.pid === 'number') {
      out.set(record.sessionId, record);
    }
  }
  return out;
}

// Whether a chat still has a process behind it. Deliberately cheap - file reads
// and a signal-0 - since it only decides whether a reopen button is offered.
function isLive(sessionId) {
  const record = readSessionRegistry().get(sessionId);
  if (!record || typeof record.pid !== 'number') return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process is there but not ours to signal.
    return error.code === 'EPERM';
  }
}

// The CLI records a 100-nanosecond FILETIME; Win32_Process only reports
// microseconds, so a millisecond of slack absorbs the lost digit.
const START_TIME_TOLERANCE = 10000n;

function sameStartTime(recorded, observed) {
  if (!recorded || !observed) return true;
  let a;
  let b;
  try {
    a = BigInt(String(recorded));
    b = BigInt(String(observed));
  } catch {
    return String(recorded) === String(observed);
  }
  const delta = a > b ? a - b : b - a;
  return delta <= START_TIME_TOLERANCE;
}

// Confirms the registry's pid is still the process it meant: checking procStart
// is what stops a recycled pid from being killed by mistake.
function liveClaudeProcess(record, table) {
  if (!record) return null;
  const proc = table.get(record.pid);
  if (!proc) return null;
  if (!/^claude\.exe$/i.test(proc.name)) return null;
  if (!sameStartTime(record.procStart, proc.fileTime)) return null;
  return proc;
}

function gitRoot() {
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
    if (!base) continue;
    const candidate = path.join(base, 'Git');
    try {
      fs.accessSync(path.join(candidate, 'git-bash.exe'), fs.constants.X_OK);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

// MSYS emulates fork(), so Windows records a parent that has already exited and
// the chain breaks. `ps -W` carries both pids and recovers what Win32 loses.
function msysProcessTable() {
  const root = gitRoot();
  if (!root) return null;
  const ps = path.join(root, 'usr', 'bin', 'ps.exe');
  let raw;
  try {
    raw = execFileSync(ps, ['-W'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return null;
  }

  const byMsysPid = new Map();
  const byWinPid = new Map();
  for (const line of raw.split('\n').slice(1)) {
    // PID PPID PGID WINPID TTY UID STIME COMMAND
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const entry = {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      winPid: Number(m[4]),
      tty: m[5],
      command: m[8].trim(),
    };
    byMsysPid.set(entry.pid, entry);
    byWinPid.set(entry.winPid, entry);
  }
  return byMsysPid.size > 0 ? { byMsysPid, byWinPid } : null;
}

const MINTTY_COMMAND = /(^|\/|\\)mintty(\.exe)?$/i;

// Stage 2 of detection. Returns the mintty window hosting a session, or null.
function detectViaMsys(claudePid) {
  const table = msysProcessTable();
  if (!table) return null;

  let current = table.byWinPid.get(claudePid);
  for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (MINTTY_COMMAND.test(current.command)) {
      return { kind: 'git-bash', pid: current.winPid, windowPid: current.winPid };
    }
    current = table.byMsysPid.get(current.ppid);
  }
  return null;
}

// The terminal a session runs in, or null - common and not an error. `pid` is
// the host app; `windowPid` is the process whose death closes the window.
function detectHost(sessionId) {
  if (IS_MAC) return require('./terminalMac').detectHost(sessionId);
  if (!SUPPORTED) return null;
  const record = readSessionRegistry().get(sessionId);
  if (!record) return null;

  const table = processTable();
  if (!liveClaudeProcess(record, table)) return null;

  let current = table.get(record.pid);
  let lastBelowHost = current;
  for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (depth > 0) {
      if (WALK_STOPS.test(current.name)) break;
      const host = HOST_IMAGES.find((entry) => entry.match.test(current.name));
      if (host) {
        return {
          kind: host.kind,
          pid: current.pid,
          exePath: current.exePath || null,
          // The topmost process below the host: killing it closes one tab.
          shellPid: lastBelowHost ? lastBelowHost.pid : record.pid,
        };
      }
      lastBelowHost = current;
    }
    current = current.ppid == null ? null : table.get(current.ppid);
  }

  // Windows ancestry came up empty. That is the Git Bash signature, so ask MSYS.
  return detectViaMsys(record.pid);
}

// wt.exe is an App Execution Alias, so existsSync/statSync report EACCES on a
// machine where it is plainly installed; only accessSync(X_OK) tells the truth.
function wtPath() {
  if (!SUPPORTED) return null;
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const candidate = path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe');
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

// Windows Terminal reparses its command line and treats ';' as a separator, so
// one in any argument would start a second command.
function escapeForWt(arg) {
  return String(arg).replace(/;/g, '\\;');
}

// Escaping cmd.exe correctly across quoting contexts isn't worth the bug
// surface, so anything carrying a metacharacter simply skips that tier.
function isCmdSafe(value) {
  return !/[&|<>^%!"]/.test(String(value));
}

// Given a forward-slash path, `start` exits 0 and launches nothing at all - no
// error, no window. Only the cmd tier needs this.
function toWindowsPath(value) {
  return String(value).replace(/\//g, '\\');
}

// Resolves once the launch has failed or survived the grace window; `settled`
// stops a slow error from opening a second terminal after the first worked.
function tryLaunch(exe, args, options) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: true }), LAUNCH_GRACE_MS);

    let child;
    try {
      child = spawn(exe, args, options);
    } catch (error) {
      finish({ ok: false, error: error.message });
      return;
    }

    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.on('exit', (code) => {
      // Normal for wt.exe: it hands off to WindowsTerminal.exe and returns.
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: `exited with code ${code}` });
    });

    child.unref();
  });
}

function gitBashPath() {
  const root = gitRoot();
  return root ? path.join(root, 'git-bash.exe') : null;
}

// C:\Users\me\bin\x.exe -> /c/Users/me/bin/x.exe, which is what the shell inside
// the window understands.
function toMsysPath(value) {
  const win = String(value).replace(/\\/g, '/');
  const drive = win.match(/^([A-Za-z]):\//);
  return drive ? `/${drive[1].toLowerCase()}/${win.slice(3)}` : win;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// mintty is driven directly: git-bash.exe --command= runs the command but opens
// no window. The trailing login shell leaves the window at a prompt afterwards.
async function launchGitBash({ cwd, exe, args, spawnOptions }) {
  const root = gitRoot();
  if (!root) return { ok: false, error: 'Git Bash not installed' };

  const mintty = path.join(root, 'usr', 'bin', 'mintty.exe');
  const command =
    `${[toMsysPath(exe), ...args].map(shellQuote).join(' ')}; exec /usr/bin/bash --login -i`;

  return tryLaunch(
    mintty,
    [
      '--nodaemon',
      '-o', 'AppID=GitForWindows.Bash',
      '-o', 'AppName=Git Bash',
      '-i', path.join(root, 'git-bash.exe'),
      '--dir', toWindowsPath(cwd),
      '--', '/usr/bin/bash', '--login', '-i', '-c', command,
    ],
    { ...spawnOptions, windowsHide: false }
  );
}

// Windows Terminal then cmd is the base chain; Git Bash is only launched when
// asked for. A `prefer` naming no tier is skipped by the caller, not an error.
function launchOrder(prefer) {
  const order = ['windows-terminal', 'console'];
  if (prefer && prefer !== 'auto') {
    if (order.includes(prefer)) order.splice(order.indexOf(prefer), 1);
    order.unshift(prefer);
  }
  return order;
}

// Opens `exe args...` in a new visible terminal at cwd. `prefer` only reorders
// the chain; every tier stays a fallback.
async function openTerminal({ cwd, exe, args = [], prefer = null }) {
  if (IS_MAC) return require('./terminalMac').openTerminal({ cwd, exe, args, prefer });
  if (!SUPPORTED) return { ok: false, via: null, error: 'Only supported on Windows.' };

  const env = childEnv();
  const spawnOptions = { detached: true, stdio: 'ignore', env };
  const failures = [];

  // Each kind is a self-contained tier returning a launched result or null,
  // recording why in `failures`.
  const tiers = {
    'git-bash': async () => {
      const result = await launchGitBash({ cwd, exe, args, spawnOptions });
      if (result.ok) return { ok: true, via: 'git-bash' };
      failures.push(`git bash: ${result.error}`);
      return null;
    },
    'windows-terminal': async () => {
      const wt = wtPath();
      if (!wt) {
        failures.push('windows terminal: not installed');
        return null;
      }
      // Windows Terminal rebuilds a command line from its arguments, so a space
      // anywhere in them is better handled by cmd's quoting.
      const spaceFree = [cwd, exe, ...args].every((value) => !/\s/.test(String(value)));
      if (!spaceFree) {
        failures.push('windows terminal: skipped, arguments contain spaces');
        return null;
      }
      const wtArgs = ['-w', 'new', '-d', cwd, exe, ...args].map(escapeForWt);
      const result = await tryLaunch(wt, wtArgs, { ...spawnOptions, windowsHide: false });
      if (result.ok) return { ok: true, via: 'windows-terminal' };
      failures.push(`windows terminal: ${result.error}`);
      return null;
    },
    console: async () => {
      if (![cwd, exe, ...args].every(isCmdSafe)) {
        failures.push('console: skipped, path contains shell metacharacters');
        return null;
      }
      const comspec = process.env.COMSPEC || 'cmd.exe';
      // One verbatim command line, not argv: Node's quoting would turn the empty
      // title token literal, and `start` reads a quoted first argument as title.
      const quoted = [toWindowsPath(exe), ...args].map((value) => `"${value}"`).join(' ');
      const line = `start "" /D "${toWindowsPath(cwd)}" ${quoted}`;
      const result = await tryLaunch(comspec, ['/d', '/s', '/c', `"${line}"`], {
        ...spawnOptions,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      if (result.ok) return { ok: true, via: 'console' };
      failures.push(`console: ${result.error}`);
      return null;
    },
  };

  // Every tier stays a fallback, and an unknown kind has no tier and is skipped.
  for (const kind of launchOrder(prefer)) {
    const tier = tiers[kind];
    if (!tier) continue;
    const result = await tier();
    if (result && result.ok) return result;
  }

  return { ok: false, via: null, error: failures.join('; ') || 'no terminal available' };
}

// The terminals this machine can be opened into, probed with the launcher's own
// helpers so the settings menu and openTerminal can't disagree.
function availableTerminals() {
  if (IS_MAC) return require('./terminalMac').availableTerminals();
  if (!SUPPORTED) return [];
  const out = ['auto'];
  if (wtPath()) out.push('windows-terminal');
  if (gitRoot()) out.push('git-bash');
  out.push('console');
  return out;
}

// The highest process whose death is safe, since taskkill /T only reaches
// descendants: mintty itself, a Windows Terminal tab's shell, else the session.
function killBoundary(record, host, closeWindow) {
  if (!closeWindow || !host) return { pid: record.pid, closes: 'session' };
  if (host.kind === 'git-bash') return { pid: host.windowPid || host.pid, closes: 'window' };
  if (host.kind === 'windows-terminal' || host.kind === 'conhost') {
    return { pid: host.shellPid || record.pid, closes: 'tab' };
  }
  return { pid: record.pid, closes: 'session' };
}

// Stops a session; with closeWindow, also closes its terminal where that takes
// nothing else down. `dryRun` reports the boundary without touching it.
function killSession(sessionId, { closeWindow = false, dryRun = false } = {}) {
  if (IS_MAC) return require('./terminalMac').killSession(sessionId, { closeWindow, dryRun });
  if (!SUPPORTED) return { killed: false, reason: 'Only supported on Windows.' };

  const record = readSessionRegistry().get(sessionId);
  if (!record) return { killed: false, reason: 'no running process found' };

  const proc = liveClaudeProcess(record, processTable());
  if (!proc) return { killed: false, reason: 'no running process found' };

  const host = closeWindow ? detectHost(sessionId) : null;
  const boundary = killBoundary(record, host, closeWindow);

  if (dryRun) {
    return { killed: false, dryRun: true, boundary, host, reason: 'dry run' };
  }

  try {
    execFileSync('taskkill.exe', ['/PID', String(boundary.pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    return { killed: true, pid: boundary.pid, closes: boundary.closes, host: host && host.kind };
  } catch (error) {
    return { killed: false, reason: (error.message || 'taskkill failed').trim() };
  }
}

module.exports = {
  SUPPORTED,
  isLive,
  sameStartTime,
  detectHost,
  detectViaMsys,
  msysProcessTable,
  gitRoot,
  gitBashPath,
  toMsysPath,
  shellQuote,
  wtPath,
  escapeForWt,
  isCmdSafe,
  toWindowsPath,
  openTerminal,
  launchOrder,
  availableTerminals,
  killSession,
  killBoundary,
  readSessionRegistry,
  SESSIONS_DIR,
};
