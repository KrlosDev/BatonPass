const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

function drawCircle(size, [r, g, b, a]) {
  const png = new PNG({ width: size, height: size });
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const inside = dx * dx + dy * dy <= radius * radius;
      png.data[idx] = inside ? r : 0;
      png.data[idx + 1] = inside ? g : 0;
      png.data[idx + 2] = inside ? b : 0;
      png.data[idx + 3] = inside ? a : 0;
    }
  }
  return png;
}

function save(png, filePath) {
  return new Promise((resolve, reject) => {
    png
      .pack()
      .pipe(fs.createWriteStream(filePath))
      .on('finish', resolve)
      .on('error', reject);
  });
}

// These are placeholders, and postinstall runs this on every `npm install` - so
// an existing file is left alone. --force regenerates regardless.
const FORCE = process.argv.includes('--force');

async function place(filePath, make) {
  if (!FORCE && fs.existsSync(filePath)) return false;
  await save(make(), filePath);
  return true;
}

async function main() {
  const outDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(outDir, { recursive: true });

  const accent = [59, 130, 246, 255]; // matches --accent in style.css
  const black = [0, 0, 0, 255];

  const written = [];
  for (const [file, make] of [
    // Windows / Linux tray icon (colored - shown as-is in the tray).
    ['tray-icon.png', () => drawCircle(32, accent)],
    // macOS template icons: black + alpha only, so macOS auto-tints them. The
    // *Template name is what makes Electron treat them as templates.
    ['trayTemplate.png', () => drawCircle(16, black)],
    ['trayTemplate@2x.png', () => drawCircle(32, black)],
    // Source for the app/installer icon.
    ['icon.png', () => drawCircle(512, accent)],
  ]) {
    if (await place(path.join(outDir, file), make)) written.push(file);
  }

  console.log(
    written.length
      ? `Generated placeholder icons in ${outDir}: ${written.join(', ')}`
      : `All icons already present in ${outDir} - left untouched (--force to replace)`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
