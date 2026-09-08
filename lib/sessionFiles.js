// Everything a session leaves on disk, and how to remove all of it. The id is
// validated as a UUID, and only paths named exactly for it are ever removed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const FILE_HISTORY_DIR = path.join(CLAUDE_DIR, 'file-history');
const SESSION_ENV_DIR = path.join(CLAUDE_DIR, 'session-env');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSessionId(value) {
  return SESSION_ID.test(String(value || ''));
}

function exists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

// Everything attributable to one session. Paths are returned whether or not
// they exist, so a caller can count what is actually there.
function findSessionFiles(sessionId) {
  if (!isSessionId(sessionId)) return null;

  const found = { transcript: null, subagentDir: null, fileHistory: null, sessionEnv: null, registry: [] };

  let projects = [];
  try {
    projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    projects = [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, project.name);
    const transcript = path.join(dir, `${sessionId}.jsonl`);
    const subagents = path.join(dir, sessionId);
    if (!found.transcript && exists(transcript)) found.transcript = transcript;
    if (!found.subagentDir && exists(subagents)) found.subagentDir = subagents;
  }

  const history = path.join(FILE_HISTORY_DIR, sessionId);
  if (exists(history)) found.fileHistory = history;

  const env = path.join(SESSION_ENV_DIR, sessionId);
  if (exists(env)) found.sessionEnv = env;

  // Registry files are named by pid, so they have to be opened to be
  // identified. The .key sibling shares the pid prefix.
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      let record;
      try {
        record = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      } catch {
        continue;
      }
      if (!record || record.sessionId !== sessionId) continue;
      found.registry.push(path.join(SESSIONS_DIR, file));
      const prefix = `${file.slice(0, -'.json'.length)}.`;
      for (const sibling of fs.readdirSync(SESSIONS_DIR)) {
        if (sibling.startsWith(prefix) && sibling.endsWith('.key')) {
          found.registry.push(path.join(SESSIONS_DIR, sibling));
        }
      }
    }
  } catch {
    // no registry directory; nothing to clean up there
  }

  return found;
}

function countFiles(found) {
  if (!found) return 0;
  let n = 0;
  for (const key of ['transcript', 'subagentDir', 'fileHistory', 'sessionEnv']) {
    if (found[key]) n++;
  }
  return n + found.registry.length;
}

// history.jsonl is shared, so it is rewritten via a temp file rather than
// removed. Lines that don't parse are kept verbatim: the file is not ours.
function pruneHistory(sessionId) {
  if (!isSessionId(sessionId)) return { removed: 0 };
  let raw;
  try {
    raw = fs.readFileSync(HISTORY_FILE, 'utf8');
  } catch {
    return { removed: 0 };
  }

  const lines = raw.split('\n');
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      kept.push(line);
      continue;
    }
    if (record && record.sessionId === sessionId) removed++;
    else kept.push(line);
  }
  if (removed === 0) return { removed: 0 };

  const temp = `${HISTORY_FILE}.batonpass-tmp`;
  fs.writeFileSync(temp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
  fs.renameSync(temp, HISTORY_FILE);
  return { removed };
}

// Removes everything findSessionFiles reports, then prunes the shared history.
// Each removal is independent, so one locked file doesn't strand the rest.
function deleteSession(sessionId) {
  if (!isSessionId(sessionId)) {
    return { ok: false, removed: [], failed: [], reason: 'not a valid session id' };
  }
  const found = findSessionFiles(sessionId);
  const removed = [];
  const failed = [];

  const targets = [found.transcript, found.subagentDir, found.fileHistory, found.sessionEnv, ...found.registry];
  for (const target of targets) {
    if (!target) continue;
    // Belt and braces: nothing is removed unless its name carries the id.
    const base = path.basename(target);
    const named = base === sessionId || base === `${sessionId}.jsonl` || target.startsWith(SESSIONS_DIR);
    if (!named) {
      failed.push({ path: target, reason: 'refused: name does not match the session' });
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      failed.push({ path: target, reason: error.message });
    }
  }

  let history = { removed: 0 };
  try {
    history = pruneHistory(sessionId);
  } catch (error) {
    failed.push({ path: HISTORY_FILE, reason: error.message });
  }

  return { ok: failed.length === 0, removed, failed, historyLines: history.removed };
}

module.exports = {
  isSessionId,
  findSessionFiles,
  countFiles,
  pruneHistory,
  deleteSession,
  PROJECTS_DIR,
  HISTORY_FILE,
};
