// Ad-hoc signs the packaged macOS app, because an unsigned Electron bundle is
// worse than an unrecognised one: the app ships with only the linker signature
// Electron's own binary carries, so the bundle has no sealed resources, and
// macOS reports that mismatch as "BatonPass is damaged and can't be opened".
// An ad-hoc signature seals the bundle and turns that back into the ordinary
// "unidentified developer" prompt, which a user can actually get past.
//
// This is an afterPack hook, not afterSign: afterSign never fires when there is
// no identity to sign with, which is exactly the case this exists for.
// electron-builder's own signing step runs after afterPack, so a real
// Developer ID - once there is one - still wins and overwrites this.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function codesign(args) {
  execFileSync('codesign', args, { stdio: 'inherit' });
}

// --deep recurses into nested bundles (the frameworks and the helper apps) but
// not into loose Mach-O files, and asarUnpack leaves koffi's .node next to the
// asar rather than inside a bundle. Signed innermost-first: sealing the app
// first and its contents second would invalidate the outer signature.
function looseBinaries(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(node|dylib|so)$/.test(entry.name)) found.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // A real certificate is present, so leave the bundle alone and let
  // electron-builder sign it properly on the step after this one.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('  • ad-hoc signing skipped, a signing identity is configured');
    return;
  }

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${path.basename(app)}`);

  for (const binary of looseBinaries(path.join(app, 'Contents', 'Resources', 'app.asar.unpacked'))) {
    codesign(['--force', '--sign', '-', '--timestamp=none', binary]);
  }
  codesign(['--force', '--deep', '--sign', '-', '--timestamp=none', app]);

  // The whole point of the hook is that the bundle is sealed, so prove it here
  // rather than finding out from a user's Gatekeeper dialog. Throwing fails the
  // build, which is the loud outcome we want.
  codesign(['--verify', '--deep', '--strict', '--verbose=2', app]);
};
