export const SUPPORTED_BROWSER_BACKENDS = ['electron', 'chrome-cdp'];

export function normalizeBrowserBackend(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'electron';
  if (raw === 'chrome' || raw === 'chrome_cdp' || raw === 'cdp') return 'chrome-cdp';
  if (SUPPORTED_BROWSER_BACKENDS.includes(raw)) return raw;
  return 'electron';
}

export function resolveBrowserBackend({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--browser-backend') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  return normalizeBrowserBackend(argValue || env.AGENTIFY_DESKTOP_BROWSER_BACKEND || settings.browserBackend);
}

export function resolveChromeExecutablePath({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-binary') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  // _BIN is the original/documented var; _PATH is an accepted alias because users
  // intuitively reach for "PATH" when overriding a binary location.
  const raw =
    argValue ||
    env.AGENTIFY_DESKTOP_CHROME_BIN ||
    env.AGENTIFY_DESKTOP_CHROME_PATH ||
    settings.chromeExecutablePath ||
    '';
  const trimmed = String(raw || '').trim();
  return trimmed || null;
}

export function resolveChromeDebugPort({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-debug-port') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = argValue || env.AGENTIFY_DESKTOP_CHROME_DEBUG_PORT || settings.chromeDebugPort;
  const port = Math.floor(Number(raw));
  if (!Number.isFinite(port) || port < 1024 || port > 65535) return 9222;
  return port;
}

export function resolveChromeProfileMode({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-profile-mode') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = String(argValue || env.AGENTIFY_DESKTOP_CHROME_PROFILE_MODE || settings.chromeProfileMode || '').trim().toLowerCase();
  return raw === 'existing' ? 'existing' : 'isolated';
}

export function resolveChromeProfileName({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-profile-name') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = String(argValue || env.AGENTIFY_DESKTOP_CHROME_PROFILE_NAME || settings.chromeProfileName || '').trim();
  return raw || 'Default';
}

export async function createBrowserBackend({
  kind,
  stateDir,
  windowDefaults,
  userAgent,
  popupPolicy,
  onChanged,
  chromeExecutablePath,
  chromeDebugPort,
  chromeProfileMode,
  chromeProfileName
} = {}) {
  const normalized = normalizeBrowserBackend(kind);
  if (normalized === 'chrome-cdp') {
    const { ChromeCdpBrowserBackend } = await import('./chrome-cdp-backend.mjs');
    return new ChromeCdpBrowserBackend({
      stateDir,
      userAgent,
      onChanged,
      executablePath: chromeExecutablePath,
      debugPort: chromeDebugPort,
      profileMode: chromeProfileMode,
      profileName: chromeProfileName
    });
  }
  const { ElectronBrowserBackend } = await import('./electron-browser-backend.mjs');
  return new ElectronBrowserBackend({
    windowDefaults,
    userAgent,
    popupPolicy,
    onChanged
  });
}
