import crypto from 'node:crypto';
import { BrowserWindow } from 'electron';

class Mutex {
  #p = Promise.resolve();
  async run(fn) {
    const start = this.#p;
    let release;
    this.#p = new Promise((r) => (release = r));
    await start;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class TabManager {
  constructor({ createController, maxTabs = 12, onNeedsAttention, windowDefaults, userAgent }) {
    this.createController = createController;
    this.maxTabs = Math.max(1, Number(maxTabs) || 12);
    this.onNeedsAttention = onNeedsAttention;
    this.windowDefaults = windowDefaults || { width: 1100, height: 800, show: false, title: 'Agentify Desktop' };
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : null;

    this.tabs = new Map(); // tabId -> { id, key, name, win, controller, createdAt, lastUsedAt }
    this.keyToId = new Map();
    this.forcedFocusTabs = new Set();
    this.mutex = new Mutex();
    this.quitting = false;
  }

  setQuitting(v = true) {
    this.quitting = !!v;
  }

  async createTab({ key = null, name = null, url = 'https://chatgpt.com/', show = false, protectedTab = false } = {}) {
    return await this.mutex.run(async () => {
      if (key && this.keyToId.has(key)) return this.keyToId.get(key);
      if (this.tabs.size >= this.maxTabs) throw new Error('max_tabs_reached');

      const id = crypto.randomUUID();
      const win = new BrowserWindow({
        ...this.windowDefaults,
        show: !!show,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          ...(this.windowDefaults.webPreferences || {})
        }
      });
      if (this.userAgent) {
        try {
          win.webContents.setUserAgent(this.userAgent);
        } catch {}
      }
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      const controller = await this.createController({ tabId: id, win });

      const tab = {
        id,
        key,
        name: name || key || `tab-${id.slice(0, 8)}`,
        win,
        controller,
        protectedTab: !!protectedTab,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      };

      this.tabs.set(id, tab);
      if (key) this.keyToId.set(key, id);

      win.on('closed', () => {
        this.tabs.delete(id);
        if (tab.key) this.keyToId.delete(tab.key);
        this.forcedFocusTabs.delete(id);
      });

      win.on('close', (e) => {
        if (this.quitting) return;
        if (!tab.protectedTab) return;
        try {
          e.preventDefault();
          if (win.isMinimized()) return;
          win.minimize();
        } catch {}
      });

      await win.loadURL(url);
      return id;
    });
  }

  async ensureTab({ key, name, show = false } = {}) {
    if (!key) throw new Error('missing_key');
    const existing = this.keyToId.get(key);
    if (existing) return existing;
    return await this.createTab({ key, name, show: !!show });
  }

  listTabs() {
    const out = [];
    for (const t of this.tabs.values()) {
      out.push({
        id: t.id,
        key: t.key || null,
        name: t.name,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt
      });
    }
    out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return out;
  }

  getControllerById(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('tab_not_found');
    if (tab.win?.isDestroyed?.() || tab.win?.webContents?.isDestroyed?.()) throw new Error('tab_closed');
    tab.lastUsedAt = Date.now();
    return tab.controller;
  }

  getWindowById(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('tab_not_found');
    tab.lastUsedAt = Date.now();
    return tab.win;
  }

  async closeTab(id) {
    return await this.mutex.run(async () => {
      const tab = this.tabs.get(id);
      if (!tab) throw new Error('tab_not_found');
      if (tab.key) this.keyToId.delete(tab.key);
      this.tabs.delete(id);
      this.forcedFocusTabs.delete(id);
      try {
        tab.win.close();
      } catch {}
      return true;
    });
  }

  async needsAttention(tabId, reason) {
    this.forcedFocusTabs.add(tabId);
    try {
      const win = this.getWindowById(tabId);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch {}
    await this.onNeedsAttention?.({ tabId, reason });
  }

  async resolvedAttention(tabId) {
    const wasForced = this.forcedFocusTabs.has(tabId);
    this.forcedFocusTabs.delete(tabId);
    // Hide only the window that we forced to the front (best-effort).
    if (wasForced) {
      try {
        const win = this.getWindowById(tabId);
        if (win.isVisible()) win.minimize();
      } catch {}
    }
    if (this.forcedFocusTabs.size === 0) {
      await this.onNeedsAttention?.({ tabId: null, reason: 'all_clear' });
    }
  }
}
