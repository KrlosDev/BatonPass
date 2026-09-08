// Derives the website's images from the same artwork the app icons come from,
// reusing the cropping and downsampling in derive-icons.js. Run: npm run site:assets
//
// The source logo is 1024x1024 and ~87% empty, so shipping it raw would be 348 KB
// of mostly transparent pixels.
const fs = require('fs');
const path = require('path');
const {
  EDGE_ALPHA,
  boundingBox,
  contentBox,
  glyphBox,
  boxCrop,
  squareCrop,
  resize,
  roundCorners,
  toPng,
} = require('./derive-icons');

const { PNG } = require('pngjs');

const ASSETS = path.join(__dirname, '..', 'assets');
// src/, not public/: Astro only optimises (and converts to WebP) images it can
// see as imports. The favicon is the exception - it is linked by URL.
const OUT_DIR = path.join(__dirname, '..', 'site', 'src', 'assets');
const PUBLIC_DIR = path.join(__dirname, '..', 'site', 'public');

const WORDMARK = path.join(ASSETS, 'BatonPassLogo.png');
const TILE = path.join(ASSETS, 'tray_icon.png');
const SHOT = path.join(ASSETS, 'screenshots', 'widget.png');

// The widget's own corner radius is 8 logical px; the capture is at ~175% DPI,
// so rounding the screenshot to match hides the strip of desktop a rectangular
// grab leaves in each corner.
const SHOT_RADIUS_PX = 14;

// The wordmark is the mark stacked above the lettering. Splitting them needs a
// horizontal cut, and the gap between the two is the widest empty band there is.
function widestEmptyBand(png) {
  const rowEmpty = [];
  for (let y = 0; y < png.height; y++) {
    let hit = false;
    for (let x = 0; x < png.width && !hit; x++) {
      if (png.data[((png.width * y + x) << 2) + 3] >= EDGE_ALPHA) hit = true;
    }
    rowEmpty.push(!hit);
  }

  const box = contentBox(png);
  let best = { start: -1, length: 0 };
  let run = -1;
  for (let y = box.minY; y <= box.maxY + 1; y++) {
    if (y <= box.maxY && rowEmpty[y]) {
      if (run < 0) run = y;
      continue;
    }
    if (run >= 0 && y - run > best.length) best = { start: run, length: y - run };
    run = -1;
  }
  return best;
}

function write(img, file, dir = OUT_DIR) {
  const target = path.join(dir, file);
  fs.writeFileSync(target, toPng(img));
  const kb = (fs.statSync(target).size / 1024).toFixed(1);
  console.log(`  ${path.relative(path.join(__dirname, '..'), target)}  ${img.width}x${img.height}  ${kb} KB`);
}

// Scales an image to a target width, keeping its aspect ratio.
function toWidth(img, width) {
  return resize(img, width, Math.max(1, Math.round((img.height / img.width) * width)));
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const logo = PNG.sync.read(fs.readFileSync(WORDMARK));
  console.log(`${path.basename(WORDMARK)}  ${logo.width}x${logo.height}`);

  // The full lockup, cropped to its own bounds. 720 is 2x the size it is shown
  // at; the artwork is a soft glow render, so every extra pixel costs real bytes.
  write(toWidth(boxCrop(logo, contentBox(logo)), 720), 'logo.png');

  // Just the mark above the lettering, for the nav and the social card.
  const gap = widestEmptyBand(logo);
  const full = contentBox(logo);
  const markOnly =
    gap.start > full.minY
      ? boundingBox(
          logo,
          (r, g, b, a, x, y) => a >= EDGE_ALPHA && y < gap.start
        )
      : full;
  write(toWidth(boxCrop(logo, markOnly), 320), 'mark.png');

  // The favicon is the app's own tile, so a browser tab and the tray agree.
  const tilePng = PNG.sync.read(fs.readFileSync(TILE));
  const tile = squareCrop(tilePng, glyphBox(tilePng));
  write(resize(roundCorners(tile, 0.22), 180), 'favicon.png', PUBLIC_DIR);

  // The screenshot is a plain rectangular grab of a rounded, transparent window,
  // so its corners carry a wedge of whatever was on the desktop behind it.
  if (fs.existsSync(SHOT)) {
    const raw = PNG.sync.read(fs.readFileSync(SHOT));
    const shot = { width: raw.width, height: raw.height, data: raw.data };
    write(roundCorners(shot, SHOT_RADIUS_PX / Math.min(shot.width, shot.height)), 'widget.png');
  } else {
    console.log(`  (no screenshot at ${path.relative(process.cwd(), SHOT)} - skipped)`);
  }
}

main();
