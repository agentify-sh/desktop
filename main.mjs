#!/usr/bin/env node
import { app, Notification } from 'electron';
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

async function main() {
  const stateDir = argValue('--state-dir') || defaultStateDir();
  const basePort = Number(argValue('--port') || process.env.AGENTIFY_DESKTOP_PORT || 0);
  const startMinimized = argFlag('--start-minimized');

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

  const tabs = new TabManager({
    maxTabs: Number(process.env.AGENTIFY_DESKTOP_MAX_TABS || 12),
    onNeedsAttention,
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
  const defaultTabId = await tabs.createTab({
    key: 'default',
    name: 'default',
    url: 'https://chatgpt.com/',
    show: !startMinimized,
    protectedTab: true
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
    tabs.setQuitting(true);
  });

  process.on('SIGINT', () => {
    try {
      server.close();
    } catch {}
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[agentify-desktop] fatal', e);
  process.exit(1);
});
