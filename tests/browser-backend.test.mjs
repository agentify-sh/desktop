import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBrowserBackend,
  resolveBrowserBackend,
  resolveChromeDebugPort,
  resolveChromeExecutablePath,
  resolveChromeProfileMode,
  resolveChromeProfileName
} from '../browser-backend.mjs';
import { buildChromeLaunchArgs, defaultChromeUserDataDir } from '../chrome-cdp-backend.mjs';

test('browser-backend: normalizes aliases', () => {
  assert.equal(normalizeBrowserBackend('chrome'), 'chrome-cdp');
  assert.equal(normalizeBrowserBackend('cdp'), 'chrome-cdp');
  assert.equal(normalizeBrowserBackend('electron'), 'electron');
  assert.equal(normalizeBrowserBackend('unknown'), 'electron');
});

test('browser-backend: argv overrides env and settings', () => {
  const value = resolveBrowserBackend({
    argv: ['node', 'main.mjs', '--browser-backend', 'chrome-cdp'],
    env: { AGENTIFY_DESKTOP_BROWSER_BACKEND: 'electron' },
    settings: { browserBackend: 'electron' }
  });
  assert.equal(value, 'chrome-cdp');
});

test('browser-backend: resolves chrome debug port and binary path', () => {
  assert.equal(
    resolveChromeDebugPort({
      argv: ['node', 'main.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_DEBUG_PORT: '9333' },
      settings: { chromeDebugPort: 9444 }
    }),
    9333
  );
  assert.equal(
    resolveChromeExecutablePath({
      argv: ['node', 'main.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_BIN: '/tmp/chrome' },
      settings: {}
    }),
    '/tmp/chrome'
  );
  // AGENTIFY_DESKTOP_CHROME_PATH must be honored as an alias of AGENTIFY_DESKTOP_CHROME_BIN.
  assert.equal(
    resolveChromeExecutablePath({
      argv: ['node', 'main.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_PATH: '/usr/bin/google-chrome-stable' },
      settings: {}
    }),
    '/usr/bin/google-chrome-stable'
  );
  // _BIN takes precedence over _PATH when both are set (back-compat with the documented var).
  assert.equal(
    resolveChromeExecutablePath({
      argv: ['node', 'main.mjs'],
      env: {
        AGENTIFY_DESKTOP_CHROME_BIN: '/tmp/bin-chrome',
        AGENTIFY_DESKTOP_CHROME_PATH: '/tmp/path-chrome'
      },
      settings: {}
    }),
    '/tmp/bin-chrome'
  );
  assert.equal(
    resolveChromeProfileMode({
      argv: ['node', 'main.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_PROFILE_MODE: 'existing' },
      settings: {}
    }),
    'existing'
  );
  assert.equal(
    resolveChromeProfileName({
      argv: ['node', 'main.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_PROFILE_NAME: 'Profile 3' },
      settings: {}
    }),
    'Profile 3'
  );
});

test('browser-backend: builds chrome launch args with managed profile', () => {
  const args = buildChromeLaunchArgs({
    debugPort: 9222,
    userDataDir: '/tmp/agentify-chrome',
    profileName: 'Default',
    startUrl: 'https://chatgpt.com/'
  });
  assert.ok(args.includes('--remote-debugging-port=9222'));
  assert.ok(args.includes('--user-data-dir=/tmp/agentify-chrome'));
  assert.ok(args.includes('--profile-directory=Default'));
  assert.ok(args.includes('https://chatgpt.com/'));
});

test('browser-backend: default chrome user data dir is non-empty', () => {
  const p = defaultChromeUserDataDir();
  assert.equal(typeof p, 'string');
  assert.ok(p.length > 0);
});
