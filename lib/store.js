const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // Phthalo green, lifted into a step visible on the panel - the true pigment
  // hex (#123524) measures 1.29:1 against it.
  accentColor: '#12a37d',
  // null means "never placed"; main.js parks the widget top-right on first run.
  widgetPosition: null,
  // One-time flag for writing ~/.claude/commands/handoff.md, so deleting the
  // file stays deleted.
  handoffCommandInstalled: false,
  // Which terminal to open handed-off and reopened chats in. 'auto' uses the one
  // detected; any other value only reorders the launch chain (see openTerminal).
  defaultTerminal: 'auto',
};

// Exactly the terminals openTerminal can launch into on this platform, so a
// value copied from another OS falls back to 'auto' in loadTerminal.
const TERMINAL_CHOICES =
  process.platform === 'darwin'
    ? ['auto', 'terminal', 'iterm2']
    : ['auto', 'windows-terminal', 'git-bash', 'console'];

// The colour lands in a CSS custom property, so only a plain 6-digit hex gets
// through - a hand-edited file can't close the declaration and append its own.
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function storePath() {
  return path.join(app.getPath('userData'), 'batonpass-settings.json');
}

function readStore(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function load() {
  const stored = readStore(storePath());
  return stored ? { ...DEFAULTS, ...stored } : { ...DEFAULTS };
}

function save(partial) {
  const next = { ...load(), ...partial };
  // Only keys the app still understands are written back; load() spreads
  // whatever is on disk over the defaults, so old ones would live forever.
  const kept = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, next[key]]));
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(kept, null, 2));
  return kept;
}

// save() drops unknown keys, but only when something prompts a write; this
// forces one at startup so a stale file doesn't sit there indefinitely.
function pruneLegacyKeys() {
  const unknown = Object.keys(load()).filter((key) => !(key in DEFAULTS));
  if (unknown.length > 0) save({});
  return unknown;
}

// Anything unusable falls back to the default, so the panel can never come up
// with a colour it can't paint.
function loadAccent() {
  const stored = load().accentColor;
  return HEX_COLOR.test(stored || '') ? stored.toLowerCase() : DEFAULTS.accentColor;
}

function setAccent(hex) {
  if (!HEX_COLOR.test(hex || '')) return loadAccent();
  save({ accentColor: hex.toLowerCase() });
  return loadAccent();
}

const isHexColor = (hex) => HEX_COLOR.test(hex || '');

// An unknown or cross-platform value falls back to 'auto', so a copied file can
// never name a terminal this OS can't open.
function loadTerminal() {
  const stored = load().defaultTerminal;
  return TERMINAL_CHOICES.includes(stored) ? stored : 'auto';
}

function setTerminal(choice) {
  if (!TERMINAL_CHOICES.includes(choice)) return loadTerminal();
  save({ defaultTerminal: choice });
  return loadTerminal();
}

function loadWidgetPosition() {
  const stored = load().widgetPosition;
  if (!stored || !Number.isFinite(stored.x) || !Number.isFinite(stored.y)) return null;
  return { x: Math.round(stored.x), y: Math.round(stored.y) };
}

function setWidgetPosition({ x, y }) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return loadWidgetPosition();
  save({ widgetPosition: { x: Math.round(x), y: Math.round(y) } });
  return loadWidgetPosition();
}

module.exports = {
  load,
  save,
  pruneLegacyKeys,
  loadAccent,
  setAccent,
  isHexColor,
  loadTerminal,
  setTerminal,
  TERMINAL_CHOICES,
  loadWidgetPosition,
  setWidgetPosition,
  DEFAULTS,
};
