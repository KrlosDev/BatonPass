// Loaded by both windows ahead of their own script: window chrome only, nothing
// that knows about usage data or settings rows.

const WHITE = '#ffffff';
const BLACK = '#0b0b0b';

// WCAG relative luminance, so which ink survives on a colour is measured rather
// than guessed - a picker can hand us white bars on white.
function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function readableInk(hex) {
  return contrastRatio(WHITE, hex) >= contrastRatio(BLACK, hex) ? WHITE : BLACK;
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// The real backdrop is a system material over the wallpaper, so these stand in
// for what each panel settles towards - enough to catch black-on-black.
function themeSurface() {
  return darkQuery.matches ? '#17181c' : '#fafaf8';
}

// The accent is the only colour set from script, so the theme stays in CSS.
function applyAccentTokens(accent) {
  const root = document.documentElement;
  root.style.setProperty('--data-color', accent);
  // Whatever sits on the accent has to flip when someone picks a pale colour.
  root.style.setProperty('--data-ink', readableInk(accent));
}

// No focused/unfocused handling: lib/blurBehind.js has DWM blur the window
// directly, which doesn't stop when focus is lost.
function initWindowChrome() {
  document.documentElement.dataset.platform = window.batonPass.platform;
}

// Asks main to size this window to what's visible, only on a real change so a
// background poll doesn't spam IPC.
function makeHeightReporter(scroller) {
  let lastReported = 0;
  return () => {
    const height = scroller.scrollHeight;
    if (height === lastReported) return;
    lastReported = height;
    window.batonPass.fitWindow(height);
  };
}
