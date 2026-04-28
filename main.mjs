#!/usr/bin/env node
import { app, Notification, BrowserWindow, ipcMain, shell, Menu, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import {
  createBrowserBackend,
  resolveBrowserBackend,
  resolveChromeDebugPort,
  resolveChromeExecutablePath,
  resolveChromeProfileMode,
  resolveChromeProfileName
} from './browser-backend.mjs';
import { ChatGPTController } from './chatgpt-controller.mjs';
import { startHttpApi } from './http-api.mjs';
import { TabManager } from './tab-manager.mjs';
import { defaultStateDir, ensureToken, readSettings, writeSettings, defaultSettings, writeState } from './state.mjs';
import { createWatchFolderManager } from './watch-folder.mjs';
import { getWorkspace, setWorkspace } from './orchestrator/storage.mjs';
import { logPath as orchestratorLogPath } from './orchestrator/logging.mjs';
import { shouldAllowPopup } from './popup-policy.mjs';
import { cleanupRuntimeResources, createGracefulShutdown, registerShutdownSignals } from './shutdown.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function argFlag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function buildChromeUserAgent() {
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  const chromeVersion = process.versions?.chrome || '120.0.0.0';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

async function loadSelectors(stateDir) {
  const defaults = JSON.parse(await fs.readFile(path.join(__dirname, 'selectors.json'), 'utf8'));
  const overridePath = path.join(stateDir, 'selectors.override.json');
  try {
    const override = JSON.parse(await fs.readFile(overridePath, 'utf8'));
    if (override && typeof override === 'object') {
      const cleaned = {};
      for (const [k, v] of Object.entries(override)) {
        if (!Object.prototype.hasOwnProperty.call(defaults, k)) continue;
        if (typeof v !== 'string' || !v.trim()) continue;
        cleaned[k] = v.trim();
      }
      return { ...defaults, ...cleaned };
    }
  } catch {}
  return defaults;
}

async function loadVendors() {
  const raw = await fs.readFile(path.join(__dirname, 'vendors.json'), 'utf8');
  const parsed = JSON.parse(raw || '{}');
  const vendors = Array.isArray(parsed?.vendors) ? parsed.vendors : [];
  const cleaned = [];
  for (const v of vendors) {
    if (!v || typeof v !== 'object') continue;
    const id = String(v.id || '').trim();
    const name = String(v.name || '').trim();
    const url = String(v.url || '').trim();
    const status = String(v.status || 'planned').trim();
    if (!id || !name || !url) continue;
    cleaned.push({ id, name, url, status });
  }
  return cleaned;
}

async function main() {
  let browserBackend = null;
  let watchFolders = null;
  let server = null;
  try {
    const stateDir = argValue('--state-dir') || defaultStateDir();
    const basePort = Number(argValue('--port') || process.env.AGENTIFY_DESKTOP_PORT || 0);
    const startMinimized = argFlag('--start-minimized');

  // Reduce obvious automation fingerprints (best-effort).
  try {
    app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
  } catch {}
  try {
    app.userAgentFallback = buildChromeUserAgent();
  } catch {}
  try {
    process.title = 'Agentify Desktop';
  } catch {}

  app.setName('Agentify Desktop');
  app.setPath('userData', path.join(stateDir, 'electron-user-data'));
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  let pendingSecondInstanceFocus = false;
  let focusDefaultTab = null;
  app.on('second-instance', () => {
    if (typeof focusDefaultTab === 'function') focusDefaultTab();
    else pendingSecondInstanceFocus = true;
  });

  await app.whenReady();

  const token = await ensureToken(stateDir);
  const selectors = await loadSelectors(stateDir);
  const vendors = await loadVendors();
  let settings = await readSettings(stateDir);
  const browserBackendKind = resolveBrowserBackend({ settings });
  const chromeExecutablePath = resolveChromeExecutablePath({ settings });
  const chromeDebugPort = resolveChromeDebugPort({ settings });
  const chromeProfileMode = resolveChromeProfileMode({ settings });
  const chromeProfileName = resolveChromeProfileName({ settings });
  const serverId = crypto.randomUUID();

  const notify = (body) => {
    try {
      const n = new Notification({ title: 'Agentify Desktop', body });
      n.show();
    } catch {}
  };

  const onNeedsAttention = async ({ reason }) => {
    if (reason === 'all_clear') return;
    if (reason?.kind === 'login') notify('Agentify needs attention. Please sign in to ChatGPT.');
    else if (reason?.kind === 'ui') notify('Agentify is stuck. Please bring ChatGPT to a ready state (UI changed, blocked, or needs a click).');
    else notify('Agentify needs a human check. Please solve the CAPTCHA.');
  };

  let controlWin = null;
  let quitting = false;
  const orchestrators = new Map(); // key -> { child, pid, startedAt }
  const orchestratorHistory = new Map(); // key -> { pid, startedAt, exitedAt, exitCode, signal, logPath }
  const showControlCenter = async () => {
    if (controlWin && !controlWin.isDestroyed()) {
      if (controlWin.isMinimized()) controlWin.restore();
      controlWin.show();
      controlWin.focus();
      return;
    }
    controlWin = new BrowserWindow({
      width: 520,
      height: 720,
      show: !startMinimized,
      title: 'Agentify Desktop',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'ui', 'preload.cjs')
      }
    });
    controlWin.setMenuBarVisibility(false);
    controlWin.on('close', (e) => {
      if (quitting) return;
      try {
        e.preventDefault();
        controlWin.hide();
      } catch {}
    });
    await controlWin.loadFile(path.join(__dirname, 'ui', 'control-center.html'));
  };

  const emitTabsChanged = () => {
    try {
      if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('agentify:tabsChanged');
    } catch {}
  };
  browserBackend = await createBrowserBackend({
    kind: browserBackendKind,
    stateDir,
    windowDefaults: { width: 1100, height: 800, show: !startMinimized, title: 'Agentify Desktop' },
    userAgent: app.userAgentFallback,
    onChanged: emitTabsChanged,
    popupPolicy: (details) =>
      shouldAllowPopup({
        ...details,
        allowAuthPopups: settings?.allowAuthPopups !== false
      }),
    chromeExecutablePath,
    chromeDebugPort,
    chromeProfileMode,
    chromeProfileName
  });
  const browserState = await browserBackend.start();
  watchFolders = createWatchFolderManager({
    stateDir,
    onIngested: async () => {
      emitTabsChanged();
    }
  });
  await watchFolders.start();

  const tabs = new TabManager({
    browserBackend,
    maxTabs: Number(process.env.AGENTIFY_DESKTOP_MAX_TABS || 12),
    onNeedsAttention,
    onChanged: emitTabsChanged,
    createController: async ({ tabId, page }) => {
      const controller = new ChatGPTController({
        page,
        selectors,
        stateDir,
        onBlocked: async (st) => {
          await tabs.needsAttention(tabId, st);
        },
        onUnblocked: async () => {
          await tabs.resolvedAttention(tabId);
        }
      });
      controller.serverId = serverId;
      return controller;
    }
  });

  // Default tab for legacy callers (no tabId).
  const defaultVendor =
    vendors.find((v) => v.id === 'chatgpt') ||
    vendors[0] || { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', status: 'supported' };
  const defaultTabId = await tabs.createTab({
    key: 'default',
    name: 'default',
    url: defaultVendor.url,
    show: !startMinimized,
    protectedTab: true,
    vendorId: defaultVendor.id,
    vendorName: defaultVendor.name
  });

  focusDefaultTab = () => {
    try {
      const win = tabs.getWindowById(defaultTabId);
      if (win.isMinimized?.()) win.restore?.();
      win.show?.();
      win.focus?.();
    } catch {}
  };
  if (pendingSecondInstanceFocus) focusDefaultTab();

  const buildMenu = () => {
    const template = [
      {
        label: 'Agentify Desktop',
        submenu: [
          { label: 'Control Center', accelerator: 'CmdOrCtrl+Shift+A', click: () => showControlCenter().catch(() => {}) },
          { label: 'Show Default Tab', accelerator: 'CmdOrCtrl+Shift+D', click: () => focusDefaultTab?.() },
          { type: 'separator' },
          { label: 'Quit', role: 'quit' }
        ]
      },
      {
        label: 'Tabs',
        submenu: [
          {
            label: 'New ChatGPT Tab',
            click: async () => {
              try {
                await tabs.createTab({ url: defaultVendor.url, vendorId: defaultVendor.id, vendorName: defaultVendor.name, show: true });
              } catch {}
            }
          }
        ]
      }
    ];
    try {
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    } catch {}
  };
  buildMenu();
  try {
    if (process.platform === 'darwin' && app.dock) {
      const dockMenu = Menu.buildFromTemplate([
        { label: 'Control Center', click: () => showControlCenter().catch(() => {}) },
        { label: 'Show Default Tab', click: () => focusDefaultTab?.() }
      ]);
      app.dock.setMenu(dockMenu);
    }
  } catch {}

  ipcMain.handle('agentify:getState', async () => {
    return {
      ok: true,
      vendors,
      tabs: tabs.listTabs(),
      defaultTabId,
      stateDir,
      browserBackend: browserBackendKind,
      browser: browserState,
      runtime: server?.getRuntimeState?.() || { inflightQueries: 0, activeQueries: [] }
    };
  });

  ipcMain.handle('agentify:getSettings', async () => {
    settings = await readSettings(stateDir);
    return settings;
  });

  ipcMain.handle('agentify:setSettings', async (_evt, args) => {
    if (args?.reset) {
      settings = await writeSettings(defaultSettings(), stateDir);
      return settings;
    }
    const next = { ...settings };
    const has = (k) => Object.prototype.hasOwnProperty.call(args || {}, k);
    if (has('maxInflightQueries')) next.maxInflightQueries = args.maxInflightQueries;
    if (has('maxQueriesPerMinute')) next.maxQueriesPerMinute = args.maxQueriesPerMinute;
    if (has('minTabGapMs')) next.minTabGapMs = args.minTabGapMs;
    if (has('minGlobalGapMs')) next.minGlobalGapMs = args.minGlobalGapMs;
    if (has('browserBackend')) next.browserBackend = args.browserBackend;
    if (has('chromeDebugPort')) next.chromeDebugPort = args.chromeDebugPort;
    if (has('chromeExecutablePath')) next.chromeExecutablePath = args.chromeExecutablePath;
    if (has('chromeProfileMode')) next.chromeProfileMode = args.chromeProfileMode;
    if (has('chromeProfileName')) next.chromeProfileName = args.chromeProfileName;
    if (has('showTabsByDefault')) next.showTabsByDefault = args.showTabsByDefault;
    if (has('allowAuthPopups')) next.allowAuthPopups = args.allowAuthPopups;
    if (args?.acknowledge) next.acknowledgedAt = new Date().toISOString();
    settings = await writeSettings(next, stateDir);
    return settings;
  });

  ipcMain.handle('agentify:createTab', async (_evt, args) => {
    const vendorId = String(args?.vendorId || '').trim() || 'chatgpt';
    const vendor = vendors.find((v) => v.id === vendorId) || vendors.find((v) => v.id === 'chatgpt') || vendors[0];
    if (!vendor) throw new Error('missing_vendor');
    const key = args?.key ? String(args.key).trim() : '';
    const name = args?.name ? String(args.name).trim() : '';
    const show = !!args?.show;

    const tabId = key
      ? await tabs.ensureTab({ key, name: name || null, url: vendor.url, vendorId: vendor.id, vendorName: vendor.name })
      : await tabs.createTab({ name: name || null, show, url: vendor.url, vendorId: vendor.id, vendorName: vendor.name });

    if (show) {
      const win = tabs.getWindowById(tabId);
      if (win.isMinimized?.()) win.restore?.();
      win.show?.();
      win.focus?.();
    }
    return { ok: true, tabId };
  });

  ipcMain.handle('agentify:showTab', async (_evt, args) => {
    const tabId = String(args?.tabId || '').trim();
    if (!tabId) throw new Error('missing_tabId');
    const win = tabs.getWindowById(tabId);
    if (win.isMinimized?.()) win.restore?.();
    win.show?.();
    win.focus?.();
    return { ok: true };
  });

  ipcMain.handle('agentify:hideTab', async (_evt, args) => {
    const tabId = String(args?.tabId || '').trim();
    if (!tabId) throw new Error('missing_tabId');
    const win = tabs.getWindowById(tabId);
    win.minimize?.();
    return { ok: true };
  });

  ipcMain.handle('agentify:closeTab', async (_evt, args) => {
    const tabId = String(args?.tabId || '').trim();
    if (!tabId) throw new Error('missing_tabId');
    if (tabId === defaultTabId) throw new Error('default_tab_protected');
    await tabs.closeTab(tabId);
    return { ok: true };
  });
  ipcMain.handle('agentify:stopQuery', async (_evt, args) => {
    const tabId = String(args?.tabId || '').trim() || defaultTabId;
    return await server?.stopActiveQuery?.({ tabId });
  });

  ipcMain.handle('agentify:openStateDir', async () => {
    const result = await shell.openPath(stateDir);
    if (result) throw new Error(result);
    return { ok: true };
  });

  ipcMain.handle('agentify:openArtifactsDir', async () => {
    await fs.mkdir(path.join(stateDir, 'artifacts'), { recursive: true });
    const result = await shell.openPath(path.join(stateDir, 'artifacts'));
    if (result) throw new Error(result);
    return { ok: true };
  });

  ipcMain.handle('agentify:openWatchFolder', async (_evt, args) => {
    const targetName = String(args?.name || '').trim();
    const selected = await watchFolders.getFolderByName(targetName);
    if (!selected) throw new Error('watch_folder_not_found');
    const folderPath = selected.path;
    await fs.mkdir(folderPath, { recursive: true });
    const result = await shell.openPath(folderPath);
    if (result) throw new Error(result);
    return { ok: true, folderPath, folder: selected };
  });

  ipcMain.handle('agentify:listWatchFolders', async () => {
    const folders = await watchFolders.listFolders();
    return { ok: true, folders };
  });

  ipcMain.handle('agentify:addWatchFolder', async (_evt, args) => {
    const folder = await watchFolders.addFolder({
      name: String(args?.name || '').trim(),
      folderPath: String(args?.path || '').trim()
    });
    emitTabsChanged();
    return { ok: true, folder };
  });

  ipcMain.handle('agentify:removeWatchFolder', async (_evt, args) => {
    const deleted = await watchFolders.removeFolder({ name: String(args?.name || '').trim() });
    emitTabsChanged();
    return { ok: true, deleted };
  });

  ipcMain.handle('agentify:pickWatchFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !Array.isArray(res.filePaths) || !res.filePaths[0]) return { ok: true, path: null };
    return { ok: true, path: res.filePaths[0] };
  });

  ipcMain.handle('agentify:scanWatchFolders', async () => {
    const result = await watchFolders.scan();
    emitTabsChanged();
    return { ok: true, ...(result || {}) };
  });

  ipcMain.handle('agentify:getOrchestrators', async () => {
    const running = [];
    for (const [k, v] of orchestrators.entries()) {
      if (!v?.child) continue;
      running.push({ key: k, pid: v.pid, startedAt: v.startedAt, logPath: orchestratorLogPath(stateDir, k) });
    }
    const recent = [];
    for (const [k, v] of orchestratorHistory.entries()) {
      recent.push({ key: k, ...v });
    }
    // show most recent first
    recent.sort((a, b) => String(b.exitedAt || '').localeCompare(String(a.exitedAt || '')));
    return { ok: true, running, recent: recent.slice(0, 10) };
  });

  ipcMain.handle('agentify:setWorkspaceForKey', async (_evt, args) => {
    const key = String(args?.key || '').trim();
    const workspace = String(args?.workspace || '').trim();
    if (!key) throw new Error('missing_key');
    if (!workspace) throw new Error('missing_workspace');
    const resolved = path.resolve(workspace);
    const st = await fs.stat(resolved);
    if (!st.isDirectory()) throw new Error('workspace_not_directory');
    if (resolved === path.parse(resolved).root) throw new Error('workspace_cannot_be_filesystem_root');
    await setWorkspace(stateDir, { key, workspace: { root: resolved, allowRoots: [resolved] } });
    return { ok: true };
  });

  ipcMain.handle('agentify:getWorkspaceForKey', async (_evt, args) => {
    const key = String(args?.key || '').trim();
    if (!key) throw new Error('missing_key');
    const ws = await getWorkspace(stateDir, { key });
    return { ok: true, workspace: ws };
  });

  ipcMain.handle('agentify:startOrchestrator', async (_evt, args) => {
    const key = String(args?.key || '').trim();
    if (!key) throw new Error('missing_key');
    if (orchestrators.has(key)) return { ok: true, alreadyRunning: true };

    const ws = await getWorkspace(stateDir, { key });
    const cwd = path.resolve(ws?.root || process.cwd());
    const entry = path.join(__dirname, 'orchestrator.mjs');
    const child = spawn(process.execPath, [entry, '--state-dir', stateDir, '--key', key], {
      cwd,
      stdio: 'ignore',
      env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir }
    });
    const startedAt = new Date().toISOString();
    orchestrators.set(key, { child, pid: child.pid, startedAt });
    child.on('exit', (code, signal) => {
      orchestrators.delete(key);
      orchestratorHistory.set(key, {
        pid: child.pid,
        startedAt,
        exitedAt: new Date().toISOString(),
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        logPath: orchestratorLogPath(stateDir, key)
      });
      try {
        if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('agentify:tabsChanged');
      } catch {}
    });
    return { ok: true, pid: child.pid };
  });

  ipcMain.handle('agentify:stopOrchestrator', async (_evt, args) => {
    const key = String(args?.key || '').trim();
    if (!key) throw new Error('missing_key');
    const cur = orchestrators.get(key);
    if (!cur?.child) return { ok: true, notRunning: true };
    try {
      cur.child.kill('SIGTERM');
    } catch {}
    orchestrators.delete(key);
    return { ok: true };
  });

  ipcMain.handle('agentify:stopAllOrchestrators', async () => {
    for (const [k, v] of orchestrators.entries()) {
      try {
        v?.child?.kill?.('SIGTERM');
      } catch {}
      orchestrators.delete(k);
    }
    return { ok: true };
  });

  // Launch control center only after IPC handlers are registered,
  // otherwise early renderer calls can race and fail with missing handlers.
  await showControlCenter().catch(() => {});

  let port = basePort;
  const tries = port === 0 ? 1 : 20;
  for (let i = 0; i < tries; i++) {
    try {
      server = await startHttpApi({
        port,
        token,
        tabs,
        defaultTabId,
        vendors,
        serverId,
        stateDir,
        getSettings: async () => settings,
        onShow: async ({ tabId }) => {
          const win = tabs.getWindowById(tabId || defaultTabId);
          if (win.isMinimized?.()) win.restore?.();
          win.show?.();
          win.focus?.();
        },
        onHide: async ({ tabId }) => {
          const win = tabs.getWindowById(tabId || defaultTabId);
          win.minimize?.();
        },
        onShutdown: async () => {
          try {
            server?.close?.();
          } catch {}
          app.quit();
        },
        onOpenArtifactsFolder: async ({ folderPath }) => {
          await fs.mkdir(folderPath, { recursive: true });
          const result = await shell.openPath(folderPath);
          return !result;
        },
        onWatchFoldersList: async () => await watchFolders.listFolders(),
        onAddWatchFolder: async ({ name, folderPath }) => await watchFolders.addFolder({ name, folderPath }),
        onRemoveWatchFolder: async ({ name }) => await watchFolders.removeFolder({ name }),
        onOpenWatchFolder: async ({ folderPath }) => {
          await fs.mkdir(folderPath, { recursive: true });
          const result = await shell.openPath(folderPath);
          return !result;
        },
        onScanWatchFolder: async () => await watchFolders.scan(),
        onRuntimeChanged: async () => {
          emitTabsChanged();
        },
        getStatus: async ({ tabId }) => {
          const controller = tabId ? tabs.getControllerById(tabId) : tabs.getControllerById(defaultTabId);
          const url = await controller.getUrl().catch(() => '');
          const challenge = await controller.detectChallenge().catch(() => null);
          return {
            ok: true,
            tabId: tabId || defaultTabId,
            url,
            blocked: !!challenge?.blocked,
            promptVisible: !!challenge?.promptVisible,
            kind: challenge?.kind || null,
            indicators: challenge?.indicators || null,
            tabs: tabs.listTabs()
          };
        }
      });
      try {
        port = server.address().port;
      } catch {}
      break;
    } catch (e) {
      if (e?.code === 'EADDRINUSE') {
        port += 1;
        continue;
      }
      throw e;
    }
  }
  if (!server) throw new Error('http_api_start_failed');

  await writeState({ ok: true, port, pid: process.pid, serverId, startedAt: new Date().toISOString() }, stateDir);

  const shutdown = createGracefulShutdown({
    closeServer: (done) => {
      try {
        if (!server?.listening) {
          done?.();
          return;
        }
        server.close(() => done?.());
      } catch {
        done?.();
      }
    },
    stopWatchFolders: async () => {
      await watchFolders.stop();
    },
    disposeBrowserBackend: async () => {
      await browserBackend.dispose?.();
    },
    stopOrchestrators: () => {
      for (const v of orchestrators.values()) {
        try {
          v?.child?.kill?.('SIGTERM');
        } catch {}
      }
    },
    setTabsQuitting: () => tabs.setQuitting(true),
    markQuitting: () => {
      quitting = true;
    },
    quitApp: () => app.quit()
  });

  app.on('before-quit', shutdown.handleBeforeQuit);

  registerShutdownSignals({ requestQuit: shutdown.requestQuit });

  app.on('window-all-closed', () => {
    app.quit();
  });

    return { stateDir, browserBackend, watchFolders, server };
  } catch (error) {
    error.browserBackend = browserBackend;
    error.watchFolders = watchFolders;
    error.server = server;
    throw error;
  }
}

main().catch(async (e) => {
  const stateDir = argValue('--state-dir') || defaultStateDir();
  try {
    const maybeServer = typeof e?.server?.close === 'function' ? e.server : null;
    await cleanupRuntimeResources({
      closeServer: (done) => {
        try {
          if (!maybeServer?.listening) {
            done?.();
            return;
          }
          maybeServer.close(() => done?.());
        } catch {
          done?.();
        }
      },
      stopWatchFolders: async () => {
        await e?.watchFolders?.stop?.();
      },
      disposeBrowserBackend: async () => {
        await e?.browserBackend?.dispose?.();
      }
    });
  } catch {}
  let detail = e?.message || String(e);
  if (e?.message === 'chrome_cdp_unavailable' && e?.data) {
    const d = e.data;
    const lines = [
      'Chrome CDP backend failed to start.',
      d.executable ? `Executable: ${d.executable}` : 'Executable: <not found>',
      d.debugPort ? `Debug port: ${d.debugPort}` : null,
      Array.isArray(d.args) && d.args.length ? `Launch args: ${d.args.join(' ')}` : null,
      d.profileMode ? `Profile mode: ${d.profileMode}${d.profileName ? ` (${d.profileName})` : ''}` : null,
      d.chromeExitCode != null ? `Chrome exit code: ${d.chromeExitCode}` : null,
      d.chromeStderr ? `Chrome stderr (tail):\n${d.chromeStderr}` : null,
      d.hint ? `\nSuggested fix: ${d.hint}` : null
    ].filter(Boolean);
    detail = lines.join('\n');
  } else if (e?.message === 'chrome_binary_not_found' || e?.message?.startsWith?.('chrome_binary_not_found')) {
    detail =
      'Could not locate a Chrome/Chromium binary on this system.\n' +
      'Install Google Chrome or Chromium, or set AGENTIFY_DESKTOP_CHROME_PATH=/absolute/path/to/chrome.';
  }
  writeState(
    {
      ok: false,
      error: e?.message || String(e),
      data: e?.data || null,
      startedAt: new Date().toISOString()
    },
    stateDir
  ).catch(() => {});
  try {
    dialog.showErrorBox('Agentify Desktop failed to start', detail);
  } catch {}
  console.error('agentify-desktop fatal:', e);
  process.exit(1);
});
