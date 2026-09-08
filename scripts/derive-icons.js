// Derives every icon the app ships from the source artwork, so the four files
// can never drift apart. Run: npm run icons [-- app.png [tray.png]]
//
// The tray takes an optional second artwork, because a design that reads at 512
// rarely survives 16 - see "Icons" in the README.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const OUT_DIR = path.join(__dirname, '..', 'assets');
const SOURCE = process.argv[2] || path.join(OUT_DIR, 'tray_icon.png');
const TRAY_SOURCE = process.argv[3] || SOURCE;

// Below this the pixel is the render's drop shadow, not the artwork itself.
const EDGE_ALPHA = 32;

// The tile is near-black and the glyph is a bright green, so brightness alone
// separates them. Ramped rather than a hard cut, to keep the antialiased edge.
const KEY_LO = 45;
const KEY_HI = 110;

// Breathing room around the tray crop, so antialiasing isn't clipped flush.
const TRAY_MARGIN = 0.02;

// Cropping tight to the glyph cuts the tile's own rounded corners away, so they
// are redrawn at the new size. Roughly the radius the artwork already uses.
const CORNER_RADIUS = 0.22;

const at = (png, x, y) => (png.width * y + x) << 2;

function boundingBox(png, keep) {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = at(png, x, y);
      // x and y are passed too, so a caller can bound a region as well as a colour.
      if (!keep(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3], x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('found nothing to crop to in the source image');
  return { minX, minY, maxX, maxY };
}

// The whole artwork, ignoring the shadow that fades out around it.
const contentBox = (png) => boundingBox(png, (r, g, b, a) => a >= EDGE_ALPHA);

// Just the bright mark inside the tile. Cropping the tray to this rather than to
// the tile is what stops a quarter of every icon being the tile's own padding.
const glyphBox = (png) =>
  boundingBox(png, (r, g, b, a) => a >= EDGE_ALPHA && Math.max(r, g, b) >= KEY_HI);

function grow(box, fraction, png) {
  const pad = Math.round(Math.max(box.maxX - box.minX, box.maxY - box.minY) * fraction);
  return {
    minX: Math.max(0, box.minX - pad),
    minY: Math.max(0, box.minY - pad),
    maxX: Math.min(png.width - 1, box.maxX + pad),
    maxY: Math.min(png.height - 1, box.maxY + pad),
  };
}

// Lifts a rectangle out of the source. Anything the rectangle overhangs is
// transparent rather than an error, so callers can pad freely.
function crop(png, x0, y0, width, height) {
  const out = { width, height, data: Buffer.alloc(width * height * 4) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x0 + x;
      const sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= png.width || sy >= png.height) continue;
      png.data.copy(out.data, (width * y + x) << 2, at(png, sx, sy), at(png, sx, sy) + 4);
    }
  }
  return out;
}

// Icons are square; the box rarely is exactly, so it grows around its centre.
function squareCrop(png, box) {
  const w = box.maxX - box.minX + 1;
  const h = box.maxY - box.minY + 1;
  const size = Math.max(w, h);
  return crop(
    png,
    Math.round(box.minX + w / 2 - size / 2),
    Math.round(box.minY + h / 2 - size / 2),
    size,
    size
  );
}

// The artwork's own box, keeping its aspect ratio - for anything not an icon.
function boxCrop(png, box) {
  return crop(png, box.minX, box.minY, box.maxX - box.minX + 1, box.maxY - box.minY + 1);
}

// Drops the dark tile and keeps the glyph, so the result sits on any tray colour.
function keyOutTile(img) {
  const data = Buffer.from(img.data);
  for (let i = 0; i < data.length; i += 4) {
    const brightness = Math.max(data[i], data[i + 1], data[i + 2]);
    const t = Math.min(1, Math.max(0, (brightness - KEY_LO) / (KEY_HI - KEY_LO)));
    data[i + 3] = Math.round(data[i + 3] * t);
  }
  return { width: img.width, height: img.height, data };
}

// Box filter on premultiplied alpha - averaging straight RGBA instead pulls the
// transparent pixels' colour in and fringes every edge dark. Height defaults to
// width, since every icon here is square.
function resize(img, width, height = width) {
  const out = Buffer.alloc(width * height * 4);
  const scaleX = img.width / width;
  const scaleY = img.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scaleX);
      const y0 = Math.floor(y * scaleY);
      const x1 = Math.min(img.width, Math.floor((x + 1) * scaleX));
      const y1 = Math.min(img.height, Math.floor((y + 1) * scaleY));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < Math.max(y1, y0 + 1); sy++) {
        for (let sx = x0; sx < Math.max(x1, x0 + 1); sx++) {
          const i = (img.width * sy + sx) << 2;
          const alpha = img.data[i + 3] / 255;
          r += img.data[i] * alpha;
          g += img.data[i + 1] * alpha;
          b += img.data[i + 2] * alpha;
          a += img.data[i + 3];
          n++;
        }
      }
      const d = (width * y + x) << 2;
      const alpha = a / n;
      // Un-premultiply, guarding the fully transparent case.
      const k = alpha > 0 ? 255 / a : 0;
      out[d] = Math.round(r * k);
      out[d + 1] = Math.round(g * k);
      out[d + 2] = Math.round(b * k);
      out[d + 3] = Math.round(alpha);
    }
  }
  return { width, height, data: out };
}

// Rounds the square crop back into a tile. Applied before downsampling so the
// curve gets the resize's own antialiasing rather than a stair-stepped edge.
function roundCorners(img, fraction) {
  const size = Math.min(img.width, img.height);
  const r = size * fraction;
  const data = Buffer.from(img.data);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      // How far this pixel sits inside a corner's quarter-circle, 0 elsewhere.
      const dx = Math.max(r - (x + 0.5), x + 0.5 - (img.width - r), 0);
      const dy = Math.max(r - (y + 0.5), y + 0.5 - (img.height - r), 0);
      if (dx <= 0 || dy <= 0) continue;
      const cover = Math.min(1, Math.max(0, r - Math.hypot(dx, dy) + 0.5));
      const i = (img.width * y + x) << 2;
      data[i + 3] = Math.round(data[i + 3] * cover);
    }
  }
  return { width: img.width, height: img.height, data };
}

// macOS tints template images itself, so only the alpha carries the shape.
function toTemplate(img) {
  const data = Buffer.from(img.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
  }
  return { width: img.width, height: img.height, data };
}

function toPng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}

function write(img, file) {
  fs.writeFileSync(path.join(OUT_DIR, file), toPng(img));
  console.log(`  ${file}  ${img.width}x${img.height}`);
}

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`no source artwork at ${file}`);
  const png = PNG.sync.read(fs.readFileSync(file));
  console.log(`${path.basename(file)}  ${png.width}x${png.height}`);
  return png;
}

function main() {
  // The app icon is the artwork as drawn, padding and all - it is shown at a
  // size where that padding is the design rather than wasted room.
  const appPng = read(SOURCE);
  write(resize(squareCrop(appPng, contentBox(appPng)), 512), 'icon.png');

  // The tray crops tight to the glyph instead. A tray slot is ~32px, so tile
  // padding costs a quarter of the mark's width and it reads small beside its
  // neighbours. The tile's own pixels still fill the crop behind the glyph.
  const trayPng = TRAY_SOURCE === SOURCE ? appPng : read(TRAY_SOURCE);
  const tile = squareCrop(trayPng, grow(glyphBox(trayPng), TRAY_MARGIN, trayPng));
  write(resize(roundCorners(tile, CORNER_RADIUS), 32), 'tray-icon.png');

  // macOS can't keep the tile: a template is alpha-only, so an opaque tile would
  // render as a solid black square with the glyph swallowed inside it.
  const glyph = keyOutTile(tile);
  write(toTemplate(resize(glyph, 16)), 'trayTemplate.png');
  write(toTemplate(resize(glyph, 32)), 'trayTemplate@2x.png');
}

if (require.main === module) main();

// Shared with scripts/site-assets.js, so the site's images are cropped and
// downsampled by exactly the same code the icons are.
module.exports = {
  EDGE_ALPHA,
  boundingBox,
  contentBox,
  glyphBox,
  crop,
  squareCrop,
  boxCrop,
  resize,
  roundCorners,
  toPng,
};
