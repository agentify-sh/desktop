import crypto from 'node:crypto';

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

function normalizeVendorToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function tabMatchesVendor(tab, { vendorId = null, url = null } = {}) {
  if (!vendorId && !url) return true;
  const requestedId = normalizeVendorToken(vendorId);
  const currentId = normalizeVendorToken(tab?.vendorId || '');
  if (requestedId && currentId) return requestedId === currentId;
  const currentUrl = String(tab?.url || '').trim();
  const requestedUrl = String(url || '').trim();
  if (currentUrl && requestedUrl) return currentUrl.startsWith(requestedUrl) || requestedUrl.startsWith(currentUrl);
  return false;
}

export class TabManager {
  constructor({ browserBackend, createController, maxTabs = 12, onNeedsAttention, onChanged }) {
    this.browserBackend = browserBackend;
    this.createController = createController;
    this.maxTabs = Math.max(1, Number(maxTabs) || 12);
    this.onNeedsAttention = onNeedsAttention;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;

    this.tabs = new Map(); // tabId -> { id, key, name, vendorId, vendorName, url, session, presenter, controller, createdAt, lastUsedAt }
    this.keyToId = new Map();
    this.forcedFocusTabs = new Set();
    this.mutex = new Mutex();
    this.quitting = false;
  }

  setQuitting(v = true) {
    this.quitting = !!v;
    this.browserBackend?.setQuitting?.(this.quitting);
  }

  async createTab({ key = null, name = null, url = 'https://chatgpt.com/', show = false, protectedTab = false, vendorId = null, vendorName = null } = {}) {
    return await this.mutex.run(async () => {
      if (key && this.keyToId.has(key)) return this.keyToId.get(key);
      if (this.tabs.size >= this.maxTabs) throw new Error('max_tabs_reached');

      const id = crypto.randomUUID();
      let finalized = false;
      const finalizeClose = () => {
        if (finalized) return;
        finalized = true;
        this.tabs.delete(id);
        if (key) this.keyToId.delete(key);
        this.forcedFocusTabs.delete(id);
        this.onChanged?.();
      };

      const session = await this.browserBackend.createSession({
        tabId: id,
        url,
        show,
        protectedTab,
        vendorId,
        vendorName,
        onClosed: finalizeClose
      });
      let controller = null;
      try {
        controller = await this.createController({ tabId: id, page: session.page, session });
      } catch (error) {
        try {
          await session?.close?.();
        } catch {}
        finalizeClose();
        throw error;
      }

      const tab = {
        id,
        key,
        name: name || key || `tab-${id.slice(0, 8)}`,
        vendorId: vendorId || null,
        vendorName: vendorName || null,
        url: String(url || ''),
        session,
        presenter: session.presenter,
        controller,
        protectedTab: !!protectedTab,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      };

      this.tabs.set(id, tab);
      if (key) this.keyToId.set(key, id);
      this.onChanged?.();
      return id;
    });
  }

  async ensureTab({ key, name, url, vendorId, vendorName, show } = {}) {
    if (!key) throw new Error('missing_key');
    const existing = this.keyToId.get(key);
    if (existing) {
      const tab = this.tabs.get(existing);
      if (!tab) {
        this.keyToId.delete(key);
        return await this.createTab({ key, name, show: !!show, url, vendorId, vendorName });
      }
      if (!tabMatchesVendor(tab, { vendorId, url })) throw new Error('key_vendor_mismatch');
      return existing;
    }
    return await this.createTab({ key, name, show: !!show, url, vendorId, vendorName });
  }

  listTabs() {
    const out = [];
    for (const t of this.tabs.values()) {
      out.push({
        id: t.id,
        key: t.key || null,
        name: t.name,
        vendorId: t.vendorId || null,
        vendorName: t.vendorName || null,
        url: t.url || null,
        protectedTab: !!t.protectedTab,
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
    if (tab.session?.isClosed?.()) throw new Error('tab_closed');
    tab.lastUsedAt = Date.now();
    return tab.controller;
  }

  getWindowById(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('tab_not_found');
    if (tab.session?.isClosed?.()) throw new Error('tab_closed');
    tab.lastUsedAt = Date.now();
    return tab.presenter;
  }

  async closeTab(id) {
    return await this.mutex.run(async () => {
      const tab = this.tabs.get(id);
      if (!tab) throw new Error('tab_not_found');
      if (tab.key) this.keyToId.delete(tab.key);
      this.tabs.delete(id);
      this.forcedFocusTabs.delete(id);
      try {
        await tab.session?.close?.();
      } catch {}
      this.onChanged?.();
      return true;
    });
  }

  async needsAttention(tabId, reason) {
    this.forcedFocusTabs.add(tabId);
    try {
      const presenter = this.getWindowById(tabId);
      if (presenter.isMinimized?.()) presenter.restore?.();
      presenter.show?.();
      presenter.focus?.();
    } catch {}
    await this.onNeedsAttention?.({ tabId, reason });
  }

  async resolvedAttention(tabId) {
    const wasForced = this.forcedFocusTabs.has(tabId);
    this.forcedFocusTabs.delete(tabId);
    if (wasForced) {
      try {
        const presenter = this.getWindowById(tabId);
        if (presenter.isVisible?.()) presenter.minimize?.();
      } catch {}
    }
    if (this.forcedFocusTabs.size === 0) {
      await this.onNeedsAttention?.({ tabId: null, reason: 'all_clear' });
    }
  }
}
