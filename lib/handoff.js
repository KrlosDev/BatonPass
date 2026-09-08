// The handoff: summarise -> validate -> save -> launch -> mark -> kill. Every
// step that can fail runs before any step the user can't undo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const claudeCli = require('./claudeCli');
const terminal = require('./terminal');
const handoffPrompt = require('./handoffPrompt');
const sessionFiles = require('./sessionFiles');
const terminalMemory = require('./terminalMemory');
const store = require('./store');

// Where to open a chat: an explicit setting wins, 'auto' defers to what was
// detected. Only reorders openTerminal's chain, so it always opens something.
function preferredKind(detectedKind) {
  const choice = store.loadTerminal();
  return choice && choice !== 'auto' ? choice : detectedKind || null;
}

const HANDOFF_ROOT = path.join(os.homedir(), '.claude', 'handoffs');
const INDEX_PATH = path.join(HANDOFF_ROOT, 'index.json');

// How long a finished job keeps saying so before the row goes back to normal.
const RESULT_LINGER_MS = 8000;

// sessionId -> job state. A running entry is also the guard against a second click.
const jobs = new Map();
// Fork ids this process has handed out, so main can keep them off the list if
// the CLI persists them after all.
const forks = new Set();
const timers = new Map();
let running = null;

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeIndex(index) {
  fs.mkdirSync(HANDOFF_ROOT, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}

function handovers() {
  return readIndex();
}

// Slack on the "written to since the handover?" mtime gate: a dying process
// flushes one last record after the kill returned. See reconcile().
const REVIVE_TOLERANCE_MS = 5000;

function transcriptMtimeOf(sessionId) {
  const files = sessionFiles.findSessionFiles(sessionId);
  if (!files || !files.transcript) return null;
  try {
    return fs.statSync(files.transcript).mtimeMs;
  } catch {
    return null;
  }
}

// A handed-over chat written to since AND live again is one you went back to, so
// it rejoins the active list. isLive tells that from the kill's final flush.
function reconcile(sessions) {
  const index = readIndex();
  let changed = false;

  for (const session of sessions) {
    const entry = index[session.sessionId];
    if (!entry) continue;
    // Entries written before the baseline was recorded fall back to `at`.
    const baseline = Number.isFinite(entry.transcriptMtime)
      ? entry.transcriptMtime
      : Date.parse(entry.at);
    if (!Number.isFinite(baseline)) continue;
    if (
      session.lastActivity > baseline + REVIVE_TOLERANCE_MS &&
      terminal.isLive(session.sessionId)
    ) {
      delete index[session.sessionId];
      changed = true;
    }
  }

  if (changed) {
    try {
      writeIndex(index);
    } catch {
      // Worst case the row reappears on the next poll; not worth failing over.
    }
  }
  return index;
}

// Flattens control characters and multi-line stderr from a child process into
// something a 380px title attribute can carry.
function tidy(message) {
  return String(message || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .slice(0, 200);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function stamp(date) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// Safe by construction: the output is only [A-Za-z0-9._-], so no command-line
// parser downstream has anything to act on.
function slug(value) {
  return (
    String(value || '')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'session'
  );
}

function handoffPath(session, when) {
  const project = slug(session.project || path.basename(session.cwd || '') || 'session');
  const shortId = String(session.sessionId || '').slice(0, 8) || 'unknown';
  return path.join(HANDOFF_ROOT, project, `${stamp(when)}-${shortId}.md`);
}

// The successor's instruction lives in the document, not the command line, so
// the launch argument stays a single space-free path.
function renderMarkdown(session, text, when) {
  const front = [
    '---',
    `title: ${JSON.stringify(String(session.title || 'Untitled chat'))}`,
    `project: ${JSON.stringify(String(session.project || ''))}`,
    `cwd: ${JSON.stringify(String(session.cwd || ''))}`,
    session.gitBranch ? `branch: ${JSON.stringify(String(session.gitBranch))}` : null,
    `model: ${JSON.stringify(String(session.model || ''))}`,
    `context: ${session.contextTokens} / ${session.limit} (${session.pct}%)`,
    `source_session: ${JSON.stringify(String(session.sessionId || ''))}`,
    `generated: ${when.toISOString()}`,
    'generator: BatonPass',
    '---',
    '',
    'You are picking up a chat that ran out of room. Read this document in full,',
    'then wait for instructions - do not start work off the back of it.',
    '',
  ];
  return `${front.filter((line) => line !== null).join('\n')}\n${text.trim()}\n`;
}

function setState(sessionId, patch, onChange) {
  const next = { ...(jobs.get(sessionId) || { sessionId }), ...patch };
  jobs.set(sessionId, next);
  if (onChange) onChange(next);

  // The linger timer lives here, not in the renderer, so a widget reload
  // mid-linger doesn't leave a row stuck on a result forever.
  const existing = timers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(sessionId);
  }
  if (next.status === 'done' || next.status === 'failed') {
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        const cleared = { ...jobs.get(sessionId), status: 'idle', stage: null };
        jobs.set(sessionId, cleared);
        if (onChange) onChange(cleared);
      }, RESULT_LINGER_MS)
    );
  }
  return next;
}

// Everything after the model call. Split out so a job that only failed to open
// a terminal can retry from the file it already has.
async function finishHandoff(session, filePath, onChange) {
  const exe = claudeCli.resolveExe();
  setState(session.sessionId, { stage: 'opening' }, onChange);

  // Asked before anything is killed: detection reads the live process tree.
  const host = terminal.detectHost(session.sessionId);

  // The successor's id is chosen here rather than left to the CLI, so the
  // terminal it opens in can be written down straight away.
  const successorSessionId = crypto.randomUUID();

  const opened = await terminal.openTerminal({
    cwd: session.cwd,
    exe: exe.path,
    prefer: preferredKind(host ? host.kind : null),
    // An @-mention, which Claude Code expands into the file's contents before
    // the first turn. Space-free by design; a space makes the wt tier skip itself.
    args: ['--session-id', successorSessionId, `@${filePath.replace(/\\/g, '/')}`],
  });

  if (!opened.ok) {
    // The summary survives and the old session keeps running; a second click
    // retries only this step.
    return setState(
      session.sessionId,
      {
        status: 'failed',
        stage: null,
        filePath,
        message: tidy(`Saved, but couldn't open a terminal. ${opened.error || ''}`),
      },
      onChange
    );
  }

  // Both ends of the handover are noted: where the old chat lived, and where the
  // brand-new successor was just put.
  terminalMemory.remember(successorSessionId, { kind: opened.via, cwd: session.cwd });
  if (host) terminalMemory.remember(session.sessionId, { kind: host.kind, cwd: session.cwd });

  // The window goes with the session: a Git Bash window or Windows Terminal tab
  // closes, VS Code is left alone. See killBoundary in lib/terminal.js.
  const killed = terminal.killSession(session.sessionId, { closeWindow: true });

  const index = readIndex();
  index[session.sessionId] = {
    handoffPath: filePath.replace(/\\/g, '/'),
    title: String(session.title || ''),
    project: String(session.project || ''),
    cwd: String(session.cwd || ''),
    model: String(session.model || ''),
    // What was actually used, so a later reopen lands in the same terminal.
    terminalKind: opened.via || null,
    successorSessionId,
    contextTokens: session.contextTokens,
    limit: session.limit,
    pct: session.pct,
    at: new Date().toISOString(),
    // Taken after the kill, so the dying process's final write is already in it.
    // The baseline reconcile() compares against; see REVIVE_TOLERANCE_MS.
    transcriptMtime: transcriptMtimeOf(session.sessionId),
    killed: killed.killed === true,
    closed: killed.closes || null,
  };
  try {
    writeIndex(index);
  } catch {
    // An unrecorded handover is a cosmetic loss: the terminal is open and the
    // file is written, so it must not read as failure.
  }

  return setState(
    session.sessionId,
    {
      status: 'done',
      stage: null,
      filePath,
      handedOff: true,
      message: killed.killed
        ? 'Handed off. The old chat was stopped.'
        : tidy(`Handed off. The old chat is still running (${killed.reason}).`),
    },
    onChange
  );
}

// Kicks off a handoff and returns the state synchronously. The work continues in
// the background and reports through onChange.
function start(session, onChange) {
  if (!session || !session.sessionId) {
    return { sessionId: null, status: 'failed', message: 'That chat is no longer on the list.' };
  }
  const { sessionId } = session;

  const current = jobs.get(sessionId);
  if (current && current.status === 'running') return current;

  // One at a time: two simultaneous replays of large transcripts is real money.
  if (running && running !== sessionId) {
    const busy = jobs.get(running);
    return {
      ...(current || { sessionId }),
      status: 'busy',
      message: `Another handoff is running${busy && busy.title ? ` (${busy.title})` : ''}.`,
    };
  }

  if (!session.cwd) {
    return setState(
      sessionId,
      { status: 'failed', message: 'That chat has no folder recorded.' },
      onChange
    );
  }
  try {
    if (!fs.statSync(session.cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    return setState(
      sessionId,
      { status: 'failed', message: 'That folder no longer exists.' },
      onChange
    );
  }

  const exe = claudeCli.resolveExe();
  if (!exe.ok) {
    return setState(sessionId, { status: 'failed', message: exe.reason }, onChange);
  }

  running = sessionId;

  // A run that produced a file but failed to open a terminal retries from the
  // file, so the second click only redoes the step that failed.
  const previous = jobs.get(sessionId);
  const resumable =
    previous && previous.status === 'failed' && previous.filePath && fs.existsSync(previous.filePath);

  const state = setState(
    sessionId,
    {
      status: 'running',
      stage: resumable ? 'opening' : 'summarising',
      title: session.title,
      filePath: resumable ? previous.filePath : null,
      message: null,
    },
    onChange
  );

  (async () => {
    try {
      if (resumable) {
        await finishHandoff(session, previous.filePath, onChange);
        return;
      }

      const run = claudeCli.runHandoff({
        sessionId,
        cwd: session.cwd,
        model: session.model,
        prompt: handoffPrompt.promptArgument(),
      });
      forks.add(run.forkSessionId);
      jobs.set(sessionId, { ...jobs.get(sessionId), kill: run.kill });

      const result = await run.promise;
      if (!result.ok) {
        setState(
          sessionId,
          { status: 'failed', stage: null, message: tidy(result.error), kill: null },
          onChange
        );
        return;
      }

      const when = new Date();
      const filePath = handoffPath(session, when);
      setState(sessionId, { stage: 'saving', kill: null }, onChange);
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, renderMarkdown(session, result.text, when), 'utf8');
      } catch (error) {
        setState(
          sessionId,
          { status: 'failed', stage: null, message: tidy(`Couldn't save the summary. ${error.message}`) },
          onChange
        );
        return;
      }

      await finishHandoff(session, filePath, onChange);
    } catch (error) {
      setState(
        sessionId,
        { status: 'failed', stage: null, message: tidy(error.message), kill: null },
        onChange
      );
    } finally {
      if (running === sessionId) running = null;
    }
  })();

  return state;
}

// How long a reopened chat gets to register itself before we call it a failure.
// Generous, because a false failure is worse than a slow button.
const RESUME_WAIT_MS = 12000;

function waitForSession(sessionId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (terminal.isLive(sessionId)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

// Opens a chat again in the terminal it was last seen in, preferring the
// handover record, then the note taken while it ran, then the usual chain.
async function reopen(sessionId, session = null) {
  const entry = readIndex()[sessionId];
  const remembered = terminalMemory.recall(sessionId);
  const known = entry || remembered || session;
  if (!known) return { ok: false, message: 'Nothing known about that chat.' };

  const files = sessionFiles.findSessionFiles(sessionId);
  if (!files || !files.transcript) {
    return { ok: false, message: 'That chat has been deleted and cannot be reopened.' };
  }

  const exe = claudeCli.resolveExe();
  if (!exe.ok) return { ok: false, message: exe.reason };

  const candidate =
    (entry && entry.cwd) || (remembered && remembered.cwd) || (session && session.cwd) || null;
  const cwd = candidate && fs.existsSync(candidate) ? candidate : os.homedir();
  const prefer = preferredKind(
    (entry && entry.terminalKind) || (remembered && remembered.kind) || null
  );

  const opened = await terminal.openTerminal({
    cwd,
    exe: exe.path,
    args: ['--resume', sessionId],
    prefer,
  });

  if (!opened.ok) {
    return { ok: false, message: tidy(`Couldn't open a terminal. ${opened.error || ''}`) };
  }
  // Where it lives now, for the next time the window gets closed.
  terminalMemory.remember(sessionId, { kind: opened.via, cwd });

  const where = opened.via.replace(/-/g, ' ');
  // A terminal opening only proves a terminal opened: a transcript the CLI
  // refuses would leave the window at a shell prompt and still read as success.
  const came_back = await waitForSession(sessionId, RESUME_WAIT_MS);
  return came_back
    ? { ok: true, message: `Reopened in ${where}.` }
    : {
        ok: false,
        message: `A ${where} window opened, but the chat didn't resume - its transcript may be damaged.`,
      };
}

// Stops the chat, removes everything it left on disk, and drops it from the
// handed-over list. The saved handoff summary is deliberately kept.
function remove(sessionId) {
  if (!sessionFiles.isSessionId(sessionId)) {
    return { ok: false, message: 'Not a valid chat id.' };
  }
  // A live session holds its transcript open, which Windows won't let us
  // delete, so the process goes first.
  terminal.killSession(sessionId, { closeWindow: true });

  const result = sessionFiles.deleteSession(sessionId);

  const index = readIndex();
  if (index[sessionId]) {
    delete index[sessionId];
    try {
      writeIndex(index);
    } catch {
      // The files are gone either way; a stale index row is cosmetic.
    }
  }
  jobs.delete(sessionId);

  return result.ok
    ? { ok: true, message: `Deleted (${result.removed.length} items).` }
    : { ok: false, message: tidy(`Deleted ${result.removed.length}, ${result.failed.length} failed.`) };
}

// Without the kill handles, which are functions and would not survive the trip
// over IPC.
function list() {
  const out = [];
  for (const state of jobs.values()) {
    const { kill, ...rest } = state;
    out.push(rest);
  }
  return { jobs: out, handovers: handovers() };
}

function forkSessionIds() {
  return forks;
}

function cancelAll() {
  for (const state of jobs.values()) {
    if (state.kill) state.kill();
  }
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  running = null;
}

module.exports = {
  HANDOFF_ROOT,
  INDEX_PATH,
  start,
  reopen,
  remove,
  list,
  handovers,
  reconcile,
  forkSessionIds,
  cancelAll,
  renderMarkdown,
  handoffPath,
  slug,
};
