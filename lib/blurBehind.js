const koffi = require('koffi');


const WCA_ACCENT_POLICY = 19;
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWCP_ROUND = 2;
const ACCENT_ENABLE_BLURBEHIND = 3;

const ACCENT_POLICY_BYTES = 16; // 4 x DWORD
const COMPOSITION_DATA_BYTES = 24; // DWORD + 4 pad + PVOID + SIZE_T on x64

let api = null;
let loadFailed = false;

function load() {
  if (api || loadFailed) return api;
  try {
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    api = {
      setWindowCompositionAttribute: user32.func(
        'int __stdcall SetWindowCompositionAttribute(size_t hwnd, void *data)'
      ),
      dwmSetWindowAttribute: dwmapi.func(
        'int __stdcall DwmSetWindowAttribute(size_t hwnd, uint32 attr, void *value, uint32 size)'
      ),
    };
  } catch (error) {
    console.error('[blurBehind] could not load win32 entry points:', error.message);
    loadFailed = true;
  }
  return api;
}

// getNativeWindowHandle hands back the HWND as bytes, not as a number.
function handleOf(win) {
  const buffer = win.getNativeWindowHandle();
  return buffer.length === 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
}
function gradientColor({ r = 0, g = 0, b = 0, a = 0 } = {}) {
  return (((a << 24) | (b << 16) | (g << 8) | r) >>> 0);
}

function enableBlur(win, tint) {
  const win32 = load();
  if (!win32 || win.isDestroyed()) return false;

  const accent = Buffer.alloc(ACCENT_POLICY_BYTES);
  accent.writeUInt32LE(ACCENT_ENABLE_BLURBEHIND, 0);
  accent.writeUInt32LE(0, 4); // AccentFlags
  accent.writeUInt32LE(gradientColor(tint), 8);
  accent.writeUInt32LE(0, 12); // AnimationId

  const data = Buffer.alloc(COMPOSITION_DATA_BYTES);
  data.writeUInt32LE(WCA_ACCENT_POLICY, 0);
  data.writeBigUInt64LE(koffi.address(accent), 8);
  data.writeBigUInt64LE(BigInt(ACCENT_POLICY_BYTES), 16);

  try {
    return api.setWindowCompositionAttribute(handleOf(win), data) !== 0;
  } catch (error) {
    console.error('[blurBehind] SetWindowCompositionAttribute failed:', error.message);
    return false;
  }
}

function roundCorners(win) {
  const win32 = load();
  if (!win32 || win.isDestroyed()) return false;

  const value = Buffer.alloc(4);
  value.writeUInt32LE(DWMWCP_ROUND, 0);
  try {
    // Returns an HRESULT: zero is S_OK.
    return (
      api.dwmSetWindowAttribute(
        handleOf(win),
        DWMWA_WINDOW_CORNER_PREFERENCE,
        value,
        4
      ) === 0
    );
  } catch (error) {
    console.error('[blurBehind] DwmSetWindowAttribute failed:', error.message);
    return false;
  }
}

const SUPPORTED = process.platform === 'win32';

module.exports = { SUPPORTED, enableBlur, roundCorners };
