// The handoff prompt. PROMPT_TEXT is the source of truth for BatonPass's own run;
// the copy in ~/.claude/commands is the user's, and is never overwritten.
const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMAND_NAME = 'handoff';
const COMMAND_DIR = path.join(os.homedir(), '.claude', 'commands');
const COMMAND_PATH = path.join(COMMAND_DIR, `${COMMAND_NAME}.md`);

const PROMPT_TEXT = `Generate a session handoff summary of everything we've done in this conversation so far, so I can hand it to a fresh session and continue the work exactly where we left off — use this when context has grown large and output quality is dropping.

Write it to stand completely on its own: the new session cannot see this conversation, so restate anything it needs and never refer to "above" or "earlier." Report only what actually happened — flag anything unverified or uncertain, and never fabricate progress, tests, or results. Emit the whole thing as a single copyable markdown block. Use this structure:

**Goal & status:** one line on what this task/project is trying to achieve, and one line on how far along it is (done / in-progress / blocked) and the exact next action a fresh session should take first.

**Approach & reasoning:** the strategy currently being executed and why this one was chosen over alternatives — so the new session continues the same direction instead of re-deciding.

**What changed:** specific edits, decisions, config, or commands — not vague summaries. Name the files and what changed in them. Include config keys and shape but redact secret values (tokens, credentials, connection strings).

**Current code state:** does it build/run right now? What's half-written, knowingly broken, stubbed, or applied to some files but not others — the things a fresh session would wrongly assume are finished.

**What was tested:** what was run/checked and the actual result (numbers, pass/fail, timing — whatever's concrete).

**What didn't work (and why):** approaches we tried and abandoned, and the specific reason each was rejected. This is the most important section — it stops the new session repeating dead-ends. Capture it fully whenever there's anything to report; don't shorten it for brevity.

**Conventions & gotchas learned:** preferences, patterns to follow, and landmines to avoid that came up this session but aren't written down anywhere in the code.

**Open questions / next steps:** anything unresolved or still to do.

**Key files/context:** paths, names, or references a fresh session needs to get oriented fast — and what's already understood about each, so it doesn't re-explore. Check repo state live rather than recalling it: run git status/branch and include the branch name, whether changes are committed / uncommitted / unpushed, the concrete list of changed or untracked files, and any stashes. Include how to run the relevant tests or app, plus any env vars or services it needs to run.

Keep it tight — one line per point, no padding. Length follows the work, not a fixed number: include every change, decision, and dead-end a fresh session would need, even if that runs past 10 points. Skip any section that's genuinely empty rather than padding it.`;

const COMMAND_FILE = `---
description: Generate a session handoff summary for picking up in a fresh session
---

${PROMPT_TEXT}
`;

function commandExists() {
  try {
    fs.accessSync(COMMAND_PATH, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function installCommand() {
  if (commandExists()) return { installed: false, path: COMMAND_PATH, reason: 'already present' };
  try {
    fs.mkdirSync(COMMAND_DIR, { recursive: true });
    fs.writeFileSync(COMMAND_PATH, COMMAND_FILE, 'utf8');
    return { installed: true, path: COMMAND_PATH };
  } catch (error) {
    return { installed: false, path: COMMAND_PATH, reason: error.message };
  }
}

// Always the literal text, never the /handoff shorthand: the on-disk command may
// carry personal pickup steps a toolless print run can't honour.
function promptArgument() {
  return PROMPT_TEXT;
}

module.exports = {
  PROMPT_TEXT,
  COMMAND_NAME,
  COMMAND_PATH,
  commandExists,
  installCommand,
  promptArgument,
};
