const fs = require('fs');
const os = require('os');
const path = require('path');
const { contextWindowFor } = require('./contextWindows');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// A chat stays on the list for a day after its last message: long enough to
// catch one parked near its ceiling, short enough to stay a handful of rows.
const ACTIVE_MS = 24 * 60 * 60 * 1000;

// Only the final assistant record matters and transcripts run past 10 MB, so
// the tail is read instead - sized well beyond one large tool result.
const TAIL_BYTES = 512 * 1024;

// Backward scanning stops here even if nothing was found, so a transcript with
// no title can't turn into half a megabyte of JSON.parse on every poll.
const MAX_SCAN_LINES = 600;

// Interrupts and errors are assistant records with zeroed usage, so reading one
// as current state reports an empty context for a session that is full.
const SYNTHETIC_MODEL = '<synthetic>';

// filePath -> { mtimeMs, row }
const fileCache = new Map();

function findTranscripts() {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, project.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.isFile() && file.name.endsWith('.jsonl')) out.push(path.join(dir, file.name));
    }
  }
  return out;
}

// Returns the last `bytes` of the file plus whether anything was skipped; a
// partial read starts mid-record, which is why the caller drops the first line.
function readTail(filePath, bytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString('utf8'), partial: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

// Walks lines newest-first, so the first hit of each kind is the latest. The
// substring tests keep JSON.parse off the bulky attachment and user records.
function scanBackwards(text, partial) {
  const lines = text.split('\n');
  if (partial) lines.shift();

  let latest = null;
  let title = null;
  let examined = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (latest && title) break;
    if (examined >= MAX_SCAN_LINES) break;

    const line = lines[i];
    if (!line) continue;

    const isAssistant = !latest && line.includes('"type":"assistant"');
    const isTitle = !title && line.includes('"type":"ai-title"');
    if (!isAssistant && !isTitle) continue;

    examined++;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (isTitle && record.type === 'ai-title' && record.aiTitle) {
      title = record.aiTitle;
      continue;
    }
    if (
      isAssistant &&
      record.type === 'assistant' &&
      record.message &&
      record.message.usage &&
      record.message.model &&
      record.message.model !== SYNTHETIC_MODEL
    ) {
      latest = record;
    }
  }

  return { latest, title };
}

// Everything already in context: sent uncached, served from cache, and written
// to it this turn. Output tokens reappear as input next turn, so they're out.
function contextTokensOf(usage) {
  return (
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0)
  );
}

function prettifySlug(slug) {
  if (!slug) return null;
  const words = slug.replace(/-/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

function buildRow(filePath, stat, latest, title) {
  const message = latest.message;
  const model = message.model;
  const limit = contextWindowFor(model);
  const contextTokens = contextTokensOf(message.usage);

  return {
    sessionId: latest.sessionId || path.basename(filePath, '.jsonl'),
    // The model-written title is the one a human recognises; then the opening
    // prompt's slug, then the id.
    title:
      title ||
      prettifySlug(latest.slug) ||
      `Session ${path.basename(filePath, '.jsonl').slice(0, 8)}`,
    project: latest.cwd ? path.basename(latest.cwd) : path.basename(path.dirname(filePath)),
    cwd: latest.cwd || null,
    gitBranch: latest.gitBranch || null,
    model,
    contextTokens,
    limit,
    pct: Math.round((contextTokens / limit) * 100),
    lastActivity: stat.mtimeMs,
  };
}

function readSession(filePath, stat) {
  let scan;
  try {
    const tail = readTail(filePath, TAIL_BYTES);
    scan = scanBackwards(tail.text, tail.partial);
    // A tail holding no usable record falls back to the whole file rather than
    // dropping the session off the list.
    if (!scan.latest && tail.partial) {
      scan = scanBackwards(fs.readFileSync(filePath, 'utf8'), false);
    }
  } catch {
    return null;
  }
  if (!scan.latest) return null;
  return buildRow(filePath, stat, scan.latest, scan.title);
}

// One row per chat touched in the last ACTIVE_MS, most recently active first.
// An mtime-keyed cache means a poll only re-reads transcripts that grew.
function getActiveSessions() {
  const now = Date.now();
  const seen = new Set();
  const rows = [];

  for (const filePath of findTranscripts()) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs > ACTIVE_MS) continue;

    seen.add(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      rows.push(cached.row);
      continue;
    }

    const row = readSession(filePath, stat);
    if (!row) continue;
    fileCache.set(filePath, { mtimeMs: stat.mtimeMs, row });
    rows.push(row);
  }

  for (const key of fileCache.keys()) {
    if (!seen.has(key)) fileCache.delete(key);
  }

  return rows.sort((a, b) => b.lastActivity - a.lastActivity);
}

// readSession is exported alone so one transcript can be checked without the
// active-window filter.
module.exports = { getActiveSessions, readSession, PROJECTS_DIR, ACTIVE_MS, TAIL_BYTES };
