const el = {
  closeBtn: document.getElementById('settings-close'),
  accentInput: document.getElementById('accent-input'),
  accentHex: document.getElementById('accent-hex'),
  colorsReset: document.getElementById('colors-reset'),
  colorHelp: document.getElementById('color-help'),
  startupSection: document.getElementById('startup-section'),
  startupToggle: document.getElementById('startup-toggle'),
  startupHelp: document.getElementById('startup-help'),
  terminalSection: document.getElementById('terminal-section'),
  terminalSelect: document.getElementById('terminal-select'),
  panel: document.querySelector('.panel-content'),
};

// Human names for the terminal kinds a user can pick. A kind with no entry is
// shown as-is, so a future launcher can't vanish for lacking a label.
const TERMINAL_LABELS = {
  auto: 'Automatic (detect)',
  'windows-terminal': 'Windows Terminal',
  'git-bash': 'Git Bash',
  console: 'Command Prompt',
  terminal: 'Terminal',
  iterm2: 'iTerm2',
};

let defaultAccent = '#12a37d';
const reportContentHeight = makeHeightReporter(el.panel);

function applyAccent(accent) {
  applyAccentTokens(accent);
  el.accentInput.value = accent;
  el.accentHex.textContent = accent;

  // Advisory, not a veto: it's their widget, but a 1.4:1 bar is invisible and
  // worth saying so.
  const ratio = contrastRatio(accent, themeSurface());
  el.colorHelp.hidden = ratio >= 3;
  if (ratio < 3) {
    el.colorHelp.textContent = `That sits at about ${ratio.toFixed(1)}:1 against the panel - the bars will be hard to see.`;
  }
  reportContentHeight();
}

// Re-read on every open instead of trusting the last known value: the login
// entry can also be removed from Task Manager or System Settings behind us.
async function refreshStartupToggle() {
  const { supported, enabled } = await window.batonPass.getStartup();
  el.startupSection.hidden = !supported;
  el.startupToggle.checked = enabled;
  el.startupHelp.hidden = true;
  reportContentHeight();
}

function showStartupError(message) {
  el.startupHelp.textContent = message;
  el.startupHelp.hidden = false;
  reportContentHeight();
}

initWindowChrome();

window.batonPass.onAccent(applyAccent);

window.batonPass.getPrefs().then((prefs) => {
  defaultAccent = prefs.defaultAccent;
  applyAccent(prefs.accent);
  populateTerminals(prefs.terminalChoices, prefs.terminal);
});

// An empty choice list means this platform can't open a terminal, so the whole
// group stays hidden rather than offering a dead control.
function populateTerminals(choices, current) {
  if (!choices || choices.length === 0) {
    el.terminalSection.hidden = true;
    return;
  }
  // The list holds only installed terminals, so a chosen one since uninstalled
  // is kept - flagged - rather than leaving the menu showing the wrong value.
  const kinds = choices.includes(current) ? choices : [...choices, current];
  el.terminalSelect.replaceChildren();
  for (const kind of kinds) {
    const option = document.createElement('option');
    option.value = kind;
    const label = TERMINAL_LABELS[kind] || kind;
    option.textContent = choices.includes(kind) ? label : `${label} (not installed)`;
    if (kind === current) option.selected = true;
    el.terminalSelect.appendChild(option);
  }
  el.terminalSection.hidden = false;
  reportContentHeight();
}

// Main echoes back what it stored, so a rejected value snaps the menu back to
// the truth instead of showing a choice that didn't take.
el.terminalSelect.addEventListener('change', async () => {
  const stored = await window.batonPass.setTerminal(el.terminalSelect.value);
  el.terminalSelect.value = stored;
});

refreshStartupToggle();

// The flyout closes on blur and the OS colour dialog takes focus, so pin it
// while that dialog is up and let go once focus is back here.
el.accentInput.addEventListener('click', () => window.batonPass.pinSettings(true));
window.addEventListener('focus', () => window.batonPass.pinSettings(false));

// 'input' fires continuously so the widget repaints live; 'change' fires once
// on commit, which is the only thing worth a disk write.
el.accentInput.addEventListener('input', () => {
  applyAccent(el.accentInput.value);
  window.batonPass.previewAccent(el.accentInput.value);
});
el.accentInput.addEventListener('change', async () => {
  applyAccent(await window.batonPass.setAccent(el.accentInput.value));
});

el.colorsReset.addEventListener('click', async () => {
  applyAccent(await window.batonPass.setAccent(defaultAccent));
});

// Switching Windows between light and dark repaints the acrylic under us, so
// the "can you still see the bars" reading has to be taken again.
darkQuery.addEventListener('change', () => applyAccent(el.accentInput.value));

el.startupToggle.addEventListener('change', async (event) => {
  const wanted = event.target.checked;
  el.startupToggle.disabled = true;
  try {
    const enabled = await window.batonPass.setStartup(wanted);
    // Main reports what the OS says, so a write that didn't take leaves the
    // checkbox showing the truth rather than the intent.
    el.startupToggle.checked = enabled;
    if (enabled === wanted) el.startupHelp.hidden = true;
    else showStartupError('The system did not accept the change.');
  } catch (error) {
    el.startupToggle.checked = !wanted;
    showStartupError(`Could not update startup setting: ${error.message}`);
  } finally {
    el.startupToggle.disabled = false;
  }
});

el.closeBtn.addEventListener('click', () => window.batonPass.hideSettings());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.batonPass.hideSettings();
});
