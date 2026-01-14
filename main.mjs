#!/usr/bin/env node
import { app, Notification, BrowserWindow, ipcMain, shell, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ChatGPTController } from './chatgpt-controller.mjs';
import { startHttpApi } from './http-api.mjs';
import { TabManager } from './tab-manager.mjs';
import { defaultStateDir, ensureToken, writeState } from './state.mjs';

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
        preload: path.join(__dirname, 'ui', 'preload.mjs')
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

  const tabs = new TabManager({
    maxTabs: Number(process.env.AGENTIFY_DESKTOP_MAX_TABS || 12),
    onNeedsAttention,
    userAgent: app.userAgentFallback,
    onChanged: () => {
      try {
        if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('agentify:tabsChanged');
      } catch {}
    },
    windowDefaults: { width: 1100, height: 800, show: !startMinimized, title: 'Agentify Desktop' },
    createController: async ({ tabId, win }) => {
      const controller = new ChatGPTController({
        webContents: win.webContents,
        loadURL: (url) => win.loadURL(url),
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
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch {}
  };
  if (pendingSecondInstanceFocus) focusDefaultTab();

  await showControlCenter().catch(() => {});

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
    return { ok: true, vendors, tabs: tabs.listTabs(), defaultTabId, stateDir };
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
      : await tabs.createTab({ name: name || null, show: false, url: vendor.url, vendorId: vendor.id, vendorName: vendor.name });

    if (show) {
      const win = tabs.getWindowById(tabId);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    return { ok: true, tabId };
  });

  ipcMain.handle('agentify:showTab', async (_evt, args) => {
    const tabId = String(args?.tabId || '').trim();
    if (!tabId) throw new Error('missing_tabId');
    const win = tabs.getWindowById(tabId);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return { ok: true };
  });

  ipcMain.handle('agentify:hideTab', async (_evt, args) => {
    const tabId = String(args?.tabId || '').trim();
    if (!tabId) throw new Error('missing_tabId');
    const win = tabs.getWindowById(tabId);
    win.minimize();
    return { ok: true };
  });

  ipcMain.handle('agentify:closeTab', async (_evt, args) => {
    const tabId = String(args?.tabId || '').trim();
    if (!tabId) throw new Error('missing_tabId');
    if (tabId === defaultTabId) throw new Error('default_tab_protected');
    await tabs.closeTab(tabId);
    return { ok: true };
  });

  ipcMain.handle('agentify:openStateDir', async () => {
    await shell.openPath(stateDir);
    return { ok: true };
  });

  let server = null;
  let port = basePort;
  const tries = port === 0 ? 1 : 20;
  for (let i = 0; i < tries; i++) {
    try {
      server = await startHttpApi({
        port,
        token,
        tabs,
        defaultTabId,
        serverId,
        stateDir,
        onShow: async ({ tabId }) => {
          const win = tabs.getWindowById(tabId || defaultTabId);
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        },
        onHide: async ({ tabId }) => {
          const win = tabs.getWindowById(tabId || defaultTabId);
          win.minimize();
        },
        onShutdown: async () => {
          try {
            server?.close?.();
          } catch {}
          app.quit();
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

  app.on('before-quit', () => {
    quitting = true;
    tabs.setQuitting(true);
  });

  process.on('SIGINT', () => {
    try {
      server.close();
    } catch {}
    app.quit();
  });

  app.on('activate', () => {
    showControlCenter().catch(() => {});
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[agentify-desktop] fatal', e);
  process.exit(1);
});
