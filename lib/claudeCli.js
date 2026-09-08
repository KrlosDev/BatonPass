// Runs the CLI from a windowless GUI process, resuming the chat's own transcript
// with its tools and model untouched so it still hits that session's cache.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Long enough for a full replay of a large transcript, short enough that a hung
// child doesn't hold a spinner forever.
const TIMEOUT_MS = 3 * 60 * 1000;

// A runaway child must not be able to grow the main process's heap.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

// Anything shorter is not a handoff, and would otherwise write a useless file
// and kill a live session over it.
const MIN_RESULT_CHARS = 80;

// A child inheriting the launching terminal's Claude Code variables believes it
// belongs to that session. A deny-list, so real user config still gets through.
const STRIPPED_ENV = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'NODE_OPTIONS',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
]);
const STRIPPED_PREFIX = /^CLAUDE_CODE_ENABLE_/;

// Model names come from the transcript and go onto a command line, so they are
// validated at the boundary rather than trusted.
const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/i;

// Set once a run proves the CLI rejects --no-session-persistence alongside
// --resume, so the retry only ever happens once per app lifetime.
let persistenceFlagOk = null;
let cachedExe;

// A GUI app launched from Finder inherits a minimal PATH, so the CLI's own
// children can't find git or node. The installer dirs are prepended for them.
function macPath(existing) {
  const home = os.homedir();
  const wanted = [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const have = new Set(String(existing || '').split(':').filter(Boolean));
  const prefix = wanted.filter((dir) => !have.has(dir));
  return prefix.length ? [...prefix, existing].filter(Boolean).join(':') : existing;
}

function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_ENV.has(key) || STRIPPED_PREFIX.test(key)) continue;
    env[key] = value;
  }
  if (process.platform === 'darwin') env.PATH = macPath(env.PATH);
  return env;
}

function executable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Where the native build installs itself, then the older local path, then a
// bare name so spawn searches PATH for anything neither anticipated.
function resolveExe() {
  if (cachedExe) return cachedExe;

  const home = os.homedir();
  // The Windows build installs claude.exe; every other platform installs a bare
  // `claude`. Same install locations otherwise.
  const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [
    path.join(home, '.local', 'bin', exeName),
    path.join(home, '.claude', 'local', exeName),
  ];
  for (const candidate of candidates) {
    if (executable(candidate)) {
      cachedExe = { path: candidate, ok: true };
      return cachedExe;
    }
  }
  // Bare name lets spawn search PATH, which on macOS is the childEnv PATH above.
  cachedExe = { path: exeName, ok: false, reason: 'Claude Code CLI not found.' };
  return cachedExe;
}

function buildArgs({ sessionId, forkSessionId, model, prompt, withPersistenceFlag }) {
  const args = ['--print', '--resume', sessionId, '--fork-session'];
  if (forkSessionId) args.push('--session-id', forkSessionId);
  // Keeps the fork from leaving a transcript behind, which this widget would
  // then list as a new active chat.
  if (withPersistenceFlag) args.push('--no-session-persistence');
  args.push('--output-format', 'json', '--permission-prompts', 'none');
  if (model && MODEL_NAME.test(model)) args.push('--model', model);
  // Positional and last, so the prompt can't be read as --print's value.
  args.push(prompt);
  return args;
}

// Deliberately forgiving about the envelope's field names, with raw stdout as
// the last resort rather than a parse failure.
function parseResult(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return { ok: false, error: 'The summary came back empty.' };

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return raw.length >= MIN_RESULT_CHARS
      ? { ok: true, text: raw }
      : { ok: false, error: 'The summary came back empty.' };
  }

  if (envelope && typeof envelope === 'object') {
    if (envelope.is_error === true || (envelope.subtype && envelope.subtype !== 'success')) {
      const message = envelope.error || envelope.result || envelope.subtype;
      return { ok: false, error: String(message || 'Claude Code reported an error.') };
    }
    const text = envelope.result ?? envelope.text ?? envelope.content;
    if (typeof text === 'string' && text.trim().length >= MIN_RESULT_CHARS) {
      return { ok: true, text: text.trim(), usage: envelope.usage, cost: envelope.total_cost_usd };
    }
  }
  return { ok: false, error: 'The summary came back empty.' };
}

// Usage-shaped stderr, meaning the CLI refused the flag combination rather than
// failing at the task.
function looksLikeFlagRejection(stderr) {
  return /unknown option|unknown argument|cannot be used|not supported|invalid option/i.test(
    stderr || ''
  );
}

// Returns { promise, kill } so the orchestrator can cancel a three-minute run
// when the app quits.
function runOnce(args, cwd) {
  let child = null;
  const promise = new Promise((resolve) => {
    const exe = resolveExe();
    try {
      child = spawn(exe.path, args, {
        cwd,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      });
    } catch (error) {
      resolve({ ok: false, error: `Couldn't start Claude Code (${error.code || error.message}).` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let overflowed = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        overflowed = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Couldn't start Claude Code (${error.code || error.message}).` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: 'Timed out after 3 minutes.' });
        return;
      }
      if (overflowed) {
        resolve({ ok: false, error: 'Claude Code returned more output than expected.' });
        return;
      }
      if (code !== 0) {
        const firstLine = String(stderr).trim().split('\n')[0] || `exited with code ${code}`;
        resolve({ ok: false, error: firstLine, stderr, exitCode: code });
        return;
      }
      resolve(parseResult(stdout));
    });
  });

  // The run makes no tool calls, so killing the direct child leaves nothing.
  return { promise, kill: () => child && child.kill() };
}

// Produces the handoff summary for one chat, returning { promise, kill } so a
// caller can cancel on quit without knowing about processes.
function runHandoff({ sessionId, cwd, model, prompt }) {
  const forkSessionId = crypto.randomUUID();
  let cancelled = false;
  let active = null;

  const promise = (async () => {
    const attempt = (withPersistenceFlag) => {
      const args = buildArgs({ sessionId, forkSessionId, model, prompt, withPersistenceFlag });
      active = runOnce(args, cwd);
      return active.promise;
    };

    let result = await attempt(persistenceFlagOk !== false);
    if (cancelled) return { ok: false, error: 'Cancelled.' };

    // The flag is documented as print-only, silent about --resume; if this build
    // refuses the combination, drop it once and remember.
    if (!result.ok && persistenceFlagOk === null && looksLikeFlagRejection(result.stderr)) {
      persistenceFlagOk = false;
      result = await attempt(false);
    } else if (result.ok && persistenceFlagOk === null) {
      persistenceFlagOk = true;
    }

    return { ...result, forkSessionId };
  })();

  return {
    promise,
    forkSessionId,
    kill: () => {
      cancelled = true;
      if (active && active.kill) active.kill();
    },
  };
}

module.exports = {
  resolveExe,
  childEnv,
  buildArgs,
  parseResult,
  runHandoff,
  MIN_RESULT_CHARS,
  TIMEOUT_MS,
};
