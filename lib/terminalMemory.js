// Which terminal each chat was last seen running in, learned while it still runs
// because detection needs a live process tree. Kept on disk, once per chat.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MEMORY_PATH = path.join(os.homedir(), '.claude', 'handoffs', 'terminals.json');

// A note about a chat that no longer exists is clutter, and losing a hint costs
// a fallback launch, not correctness.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function save(memory) {
  try {
    fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf8');
  } catch {
    // A hint that failed to persist is not worth failing a poll over.
  }
}

function recall(sessionId) {
  const entry = load()[sessionId];
  return entry && entry.kind ? entry : null;
}

function remember(sessionId, { kind, cwd }) {
  if (!sessionId || !kind) return;
  const memory = load();
  const existing = memory[sessionId];
  if (existing && existing.kind === kind && existing.cwd === cwd) return;
  memory[sessionId] = { kind, cwd: cwd || (existing && existing.cwd) || null, at: Date.now() };
  save(memory);
}

function forget(sessionId) {
  const memory = load();
  if (!memory[sessionId]) return;
  delete memory[sessionId];
  save(memory);
}

// Drops notes for chats no longer on the list, and anything gone stale.
function prune(knownIds) {
  const memory = load();
  const cutoff = Date.now() - MAX_AGE_MS;
  let changed = false;
  for (const [sessionId, entry] of Object.entries(memory)) {
    const expired = !entry || !Number.isFinite(entry.at) || entry.at < cutoff;
    if (expired || (knownIds && !knownIds.has(sessionId))) {
      delete memory[sessionId];
      changed = true;
    }
  }
  if (changed) save(memory);
  return memory;
}

module.exports = { MEMORY_PATH, recall, remember, forget, prune, load };
