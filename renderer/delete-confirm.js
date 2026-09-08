const panel = document.getElementById('delete-confirm-content');
const titleNode = document.getElementById('delete-confirm-message');
const projectNode = document.getElementById('delete-confirm-project');
const detailNode = document.getElementById('delete-confirm-detail');
const closeBtn = document.getElementById('delete-confirm-close');
const cancelBtn = document.getElementById('delete-confirm-cancel');
const actionBtn = document.getElementById('delete-confirm-action');

const reportHeight = makeHeightReporter(panel);

initWindowChrome();

function finish(confirmed) {
  window.batonPass.confirmDelete(confirmed);
}

window.batonPass.onDeleteConfirmSetup((config) => {
  const title = config.title || 'this chat';
  const project = config.project || '';
  const count = Number(config.count || 0);

  titleNode.textContent = `"${title}"`;
  projectNode.textContent = project ? `Project: ${project}` : '';
  projectNode.hidden = !project;
  detailNode.textContent =
    `This removes the transcript, its subagent transcripts, file history and history ` +
    `entries - ${count} item${count === 1 ? '' : 's'} on disk. Any saved handoff summary is kept.`;

  // The name and project are user text of any length, so the window can only
  // be sized once they're laid out.
  requestAnimationFrame(reportHeight);
});

closeBtn.addEventListener('click', () => finish(false));
cancelBtn.addEventListener('click', () => finish(false));
actionBtn.addEventListener('click', () => finish(true));
// Escape backs out. Enter isn't bound to the delete: it activates whichever
// button has focus, and that's Cancel.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') finish(false);
});

// Cancel holds focus: a stray key on a dialog that just appeared should never
// be the one that deletes.
cancelBtn.focus();

window.batonPass.getPrefs().then((prefs) => applyAccentTokens(prefs.accent));
