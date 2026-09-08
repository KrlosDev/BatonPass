const el = {
  sessionList: document.getElementById('session-list'),
  statusLine: document.getElementById('status-line'),
  refreshBtn: document.getElementById('refresh-btn'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  // The scrolling element, not its wrapper: only its scrollHeight reports
  // content taller than the window, which is what lets the window grow back.
  panel: document.querySelector('.panel-content'),
};

// Beyond this the window would outgrow WIDGET_MAX_HEIGHT and start scrolling;
// a safety valve, since a day's worth of chats is usually a handful.
const MAX_ROWS = 6;

// Whether this platform can open a chat in a new terminal, which is what the
// reopen and handoff buttons do. See lib/terminal.js.
const CAN_OPEN_TERMINAL = ['win32', 'darwin'].includes(window.batonPass.platform);

let lastUpdated = null;
let lastPayload = null;
// What the list looked like the last time it was built. null means "never".
let lastSignature = null;
// Job state pushed by main, and chats it has already handed over - both caches
// of what main said, never an independent opinion.
const handoffStates = new Map();
let handovers = {};
// A handoff message holds the footer until it expires, so the "last updated"
// tick doesn't overwrite the one line explaining what just happened.
let statusHoldUntil = 0;
// 'active' or 'handed'. A handed-over chat leaves the main list, so the two
// never show the same chat twice.
let activeTab = 'active';
const reportContentHeight = makeHeightReporter(el.panel);

function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${Math.round(n)}`;
}

// The denominator is a round number by nature, so it gets no decimal - "1M"
// and "200k" rather than "1.0M".
function formatLimit(n) {
  return n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}k`;
}

function formatTimeAgo(ms) {
  if (!ms) return '-';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 45) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  const hours = Math.round(seconds / 3600);
  return hours < 24 ? `${hours} hr ago` : `${Math.round(hours / 24)} d ago`;
}

// Every model here is a claude-*, so the prefix is noise in a line that already
// has to fit a project name and a timestamp.
function shortModel(model) {
  return (model || 'unknown').replace(/^claude-/, '');
}

// Where the colour changes, as a percentage of the model's context window - the
// same thing the bar's length says.
const CONTEXT_BANDS = { warning: 40, serious: 60, critical: 80 };

const STATUS_CLASSES = ['is-good', 'is-warning', 'is-serious', 'is-critical'];

const STATUS_HINT = {
  'is-good': 'Plenty of room left.',
  'is-warning': 'Filling up, but nothing to do about it yet.',
  'is-serious': 'Running low on room. Worth finishing the current task in here.',
  'is-critical':
    'Nearly full. Claude Code will start compacting the earliest turns away to make room.',
};

function contextStatus(pct) {
  if (pct == null) return null;
  if (pct < CONTEXT_BANDS.warning) return 'is-good';
  if (pct < CONTEXT_BANDS.serious) return 'is-warning';
  if (pct < CONTEXT_BANDS.critical) return 'is-serious';
  return 'is-critical';
}

const HANDOFF_GLYPH = {
  idle: '⇥',
  running: '↻',
  done: '✓',
  failed: '!',
};

const HANDOFF_STAGE_HINT = {
  summarising: 'Summarising this chat…',
  saving: 'Saving the handoff…',
  opening: 'Opening a new terminal…',
};

// Repainted in place, since re-rendering the list would restart the spinner's
// animation from frame zero on every update.
function paintHandoffButton(button, state, handover) {
  const status = state ? state.status : 'idle';
  const running = status === 'running';

  button.classList.toggle('spinning', running);
  button.classList.toggle('is-done', status === 'done');
  button.classList.toggle('is-failed', status === 'failed' || status === 'busy');
  button.disabled = running;

  if (running) {
    button.textContent = HANDOFF_GLYPH.running;
    button.title = HANDOFF_STAGE_HINT[state.stage] || 'Working…';
    return;
  }
  if (status === 'done' || status === 'failed' || status === 'busy') {
    button.textContent = status === 'done' ? HANDOFF_GLYPH.done : HANDOFF_GLYPH.failed;
    button.title = state.message || '';
    return;
  }

  button.textContent = HANDOFF_GLYPH.idle;
  button.title = handover
    ? `Already handed off. Summary at ${handover.handoffPath}`
    : 'Hand off to a fresh session in a new terminal';
}

function applyHandoffState(state) {
  if (!state || !state.sessionId) return;
  handoffStates.set(state.sessionId, state);

  // A finished handoff writes an index entry carrying more than this push does,
  // so the record is re-read from main rather than reconstructed here.
  if (state.status === 'done') {
    window.batonPass.listHandoffs().then(({ handovers: recorded }) => {
      handovers = recorded || {};
      lastSignature = null;
      renderCurrentTab();
    });
  }

  const row = el.sessionList.querySelector(
    `.session-row[data-session-id="${CSS.escape(state.sessionId)}"]`
  );
  if (row) {
    const button = row.querySelector('.handoff-btn');
    if (button) paintHandoffButton(button, state, handovers[state.sessionId]);
  }

  if (state.message && state.status !== 'running') {
    statusHoldUntil = Date.now() + 8000;
    el.statusLine.textContent = state.message;
  }
}

function buildHandoffButton(session) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'handoff-btn';
  button.setAttribute('aria-label', 'Hand off to a fresh session in a new terminal');
  paintHandoffButton(button, handoffStates.get(session.sessionId), handovers[session.sessionId]);

  button.addEventListener('click', () => {
    // Painted from the reply rather than optimistically, so a refusal shows up
    // immediately.
    window.batonPass.startHandoff(session.sessionId).then(applyHandoffState);
  });
  return button;
}

function flashStatus(message) {
  if (!message) return;
  statusHoldUntil = Date.now() + 8000;
  el.statusLine.textContent = message;
}

// Deletion is confirmed in main, so this only has to handle the answer. A
// cancelled dialog is not a failure and says nothing.
function buildDeleteButton(sessionId, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'handoff-btn danger-btn';
  button.textContent = '✕';
  button.title = `Delete ${label} permanently - transcript, subagents and history`;
  button.setAttribute('aria-label', 'Delete this chat permanently');

  button.addEventListener('click', () => {
    button.disabled = true;
    window.batonPass
      .deleteSession(sessionId)
      .then((result) => {
        if (result && !result.cancelled) flashStatus(result.message);
        if (result && result.ok) {
          delete handovers[sessionId];
          handoffStates.delete(sessionId);
          lastSignature = null;
          renderCurrentTab();
        }
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  return button;
}

// Kinds are stored lowercase and dash-separated (git-bash, iterm2); iTerm2 is
// the only name a straight de-dash gets wrong.
function prettyKind(kind) {
  if (kind === 'iterm2') return 'iTerm2';
  return String(kind).replace(/-/g, ' ');
}

function buildReopenButton(sessionId, entry, label = 'Reopen this chat') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'handoff-btn';
  button.textContent = '↺';
  const where = entry.terminalKind ? ` in ${prettyKind(entry.terminalKind)}` : '';
  button.title = `${label}${where}`;
  button.setAttribute('aria-label', 'Reopen this chat in a terminal');

  button.addEventListener('click', () => {
    button.disabled = true;
    button.classList.add('spinning');
    window.batonPass
      .reopenSession(sessionId)
      .then((result) => flashStatus(result && result.message))
      .finally(() => {
        button.disabled = false;
        button.classList.remove('spinning');
      });
  });
  return button;
}

// A handed-over chat is stopped, so it gets no context bar; the frozen figure
// goes in the meta line instead, stated as history.
function buildHandedRow(sessionId, entry) {
  const row = document.createElement('div');
  row.className = 'session-row';
  row.dataset.sessionId = sessionId;

  const title = document.createElement('p');
  title.className = 'session-title';
  title.textContent = entry.title || sessionId.slice(0, 8);
  title.title = entry.title || sessionId;

  const parts = [entry.project, entry.model ? shortModel(entry.model) : null].filter(Boolean);
  if (Number.isFinite(entry.pct)) parts.push(`${entry.pct}% when handed over`);
  parts.push(formatTimeAgo(Date.parse(entry.at)));

  const meta = document.createElement('p');
  meta.className = 'session-meta';
  meta.textContent = parts.join(' · ');
  if (entry.handoffPath) meta.title = entry.handoffPath;

  const actions = document.createElement('div');
  actions.className = 'session-bar session-actions';
  actions.append(buildReopenButton(sessionId, entry), buildDeleteButton(sessionId, 'this chat'));

  row.append(title, meta, actions);
  return row;
}

function handedEntries() {
  return Object.entries(handovers).sort(
    (a, b) => (Date.parse(b[1].at) || 0) - (Date.parse(a[1].at) || 0)
  );
}

// Built as DOM rather than an innerHTML template: the title is model-written
// free text and would otherwise be parsed as markup.
function buildRow(session, isCurrent) {
  const row = document.createElement('div');
  row.className = isCurrent ? 'session-row is-current' : 'session-row';
  const status = contextStatus(session.pct);
  if (status) row.classList.add(status);
  // The anchor a handoff update uses to find its row without a re-render.
  row.dataset.sessionId = session.sessionId;

  const title = document.createElement('p');
  title.className = 'session-title';
  title.textContent = session.title;
  title.title = session.title;

  const meta = document.createElement('p');
  meta.className = 'session-meta';
  const facts = [session.project, shortModel(session.model), formatTimeAgo(session.lastActivity)];
  // Says why the row has a reopen button on it, so the button isn't a mystery.
  if (session.live === false) facts.push('terminal closed');
  meta.textContent = facts.join(' · ');
  if (session.cwd) {
    meta.title = session.gitBranch ? `${session.cwd} · ${session.gitBranch}` : session.cwd;
  }

  const track = document.createElement('span');
  track.className = 'model-bar-track';
  const fill = document.createElement('span');
  fill.className = 'model-bar-fill';
  // Capped so a window guessed too low can't overflow the track; the figures
  // beside it still show the real numbers.
  fill.style.width = `${Math.min(100, session.pct)}%`;
  track.appendChild(fill);

  const count = document.createElement('span');
  count.className = 'session-count';
  count.textContent = `${formatTokens(session.contextTokens)} / ${formatLimit(session.limit)}`;

  const pct = document.createElement('span');
  pct.className = 'session-pct';
  pct.textContent = `${session.pct}%`;

  const bar = document.createElement('div');
  bar.className = 'session-bar';
  bar.title = STATUS_HINT[status] || '';
  bar.append(track, count, pct);

  // A listed chat with no process behind it is one whose terminal was closed,
  // which is the only case where reopening means anything.
  if (session.live === false && CAN_OPEN_TERMINAL) {
    bar.append(buildReopenButton(session.sessionId, session, 'Open this chat again'));
  }

  // No handoff button rather than one that always fails: it needs a folder and
  // a terminal it can open. Delete has neither constraint.
  if (session.cwd && CAN_OPEN_TERMINAL) {
    bar.append(buildHandoffButton(session));
  }
  bar.append(buildDeleteButton(session.sessionId, session.title));

  row.append(title, meta, bar);
  return row;
}

// Everything the rows actually display, timestamps formatted rather than raw so
// a poll inside the same minute changes nothing. The tab is in here too.
function sessionsSignature(sessions) {
  if (activeTab === 'handed') {
    const rows = handedEntries().map(
      ([id, e]) => `${id}|${e.title}|${e.project}|${e.terminalKind}|${formatTimeAgo(Date.parse(e.at))}`
    );
    return `handed\n${rows.join('\n')}`;
  }
  const rows = sessions
    .slice(0, MAX_ROWS)
    .map(
      (s) =>
        `${s.sessionId}|${s.contextTokens}|${s.pct}|${s.title}|${s.model}|${s.live}|` +
        `${s.terminalKind}|${formatTimeAgo(s.lastActivity)}`
    );
  return `active\n${rows.join('\n')}\n+${sessions.length}`;
}

function updateTabCounts(activeCount) {
  for (const tab of el.tabs) {
    const isSelected = tab.dataset.tab === activeTab;
    tab.classList.toggle('is-selected', isSelected);
    tab.setAttribute('aria-selected', String(isSelected));
    const count = tab.dataset.tab === 'active' ? activeCount : handedEntries().length;
    tab.textContent = tab.dataset.tab === 'active' ? `Active ${count}` : `Handed over ${count}`;
  }
}

// Re-renders whichever tab is showing, from the payload already in hand.
function renderCurrentTab() {
  if (lastPayload) render(lastPayload);
  else {
    lastSignature = null;
    renderSessions([]);
    reportContentHeight();
  }
}

function renderSessions(sessions) {
  // The poll fires every 20s whether or not anything moved, and rebuilding
  // unchanged rows would throw away animations, tooltips and selected text.
  const signature = sessionsSignature(sessions);
  updateTabCounts(sessions.length);
  if (signature === lastSignature) return;
  lastSignature = signature;

  el.sessionList.replaceChildren();

  if (activeTab === 'handed') {
    const entries = handedEntries();
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-hint';
      empty.textContent = 'Nothing handed over yet.';
      el.sessionList.appendChild(empty);
      return;
    }
    for (const [sessionId, entry] of entries) {
      el.sessionList.appendChild(buildHandedRow(sessionId, entry));
    }
    return;
  }

  if (sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'No chats active in the last 24 hours.';
    el.sessionList.appendChild(empty);
    return;
  }

  for (const [i, session] of sessions.slice(0, MAX_ROWS).entries()) {
    el.sessionList.appendChild(buildRow(session, i === 0));
  }

  if (sessions.length > MAX_ROWS) {
    const more = document.createElement('p');
    more.className = 'empty-hint';
    more.textContent = `+${sessions.length - MAX_ROWS} more`;
    el.sessionList.appendChild(more);
  }
}

function render(payload) {
  if (!payload.ok) {
    el.statusLine.textContent = `Error: ${payload.error}`;
    return;
  }
  lastPayload = payload;
  // Main sends the handover record with every poll, so a handoff performed
  // anywhere shows up here.
  if (payload.handovers) handovers = payload.handovers;

  renderSessions(payload.sessions);
  lastUpdated = Date.now();
  if (Date.now() >= statusHoldUntil) {
    el.statusLine.textContent = `Last updated: ${formatTimeAgo(lastUpdated)}`;
  }
  reportContentHeight();
}

initWindowChrome();

window.batonPass.onUpdate(render);
// Settings is a separate window, so the accent arrives over IPC - including
// mid-drag, before it has been committed to disk.
window.batonPass.onAccent(applyAccentTokens);
window.batonPass.onHandoff(applyHandoffState);

window.batonPass.getPrefs().then((prefs) => applyAccentTokens(prefs.accent));

// Main owns job state, so a reload asks what is in flight; otherwise a chat
// mid-handoff would show an idle button and invite a second full-cost run.
window.batonPass.listHandoffs().then(({ jobs, handovers: recorded }) => {
  handovers = recorded || {};
  for (const job of jobs || []) handoffStates.set(job.sessionId, job);
  lastSignature = null;
  renderCurrentTab();
});

for (const tab of el.tabs) {
  tab.addEventListener('click', () => {
    if (activeTab === tab.dataset.tab) return;
    activeTab = tab.dataset.tab;
    renderCurrentTab();
  });
}

el.refreshBtn.addEventListener('click', () => {
  el.refreshBtn.classList.add('spinning');
  window.batonPass.refresh().finally(() => {
    setTimeout(() => el.refreshBtn.classList.remove('spinning'), 400);
  });
});

setInterval(() => {
  if (!lastUpdated) return;
  if (Date.now() < statusHoldUntil) return;
  el.statusLine.textContent = `Last updated: ${formatTimeAgo(lastUpdated)}`;
}, 15000);
