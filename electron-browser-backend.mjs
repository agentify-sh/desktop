import electron from 'electron';

const { BrowserWindow } = electron;

function trackWindow(windows, win) {
  if (!win) return;
  windows.add(win);
  try {
    win.on('closed', () => {
      windows.delete(win);
    });
  } catch {}
}

class ElectronPageAdapter {
  constructor(win) {
    this.win = win;
  }

  isClosed() {
    return this.win?.isDestroyed?.() || this.win?.webContents?.isDestroyed?.();
  }

  async navigate(url) {
    await this.win.loadURL(url);
  }

  async evaluate(js) {
    return await this.win.webContents.executeJavaScript(js, true);
  }

  async getUrl() {
    return this.win.webContents.getURL();
  }

  async sendKey(key, { modifiers = [] } = {}) {
    const wc = this.win.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    const hasCommandModifier = Array.isArray(modifiers) && modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt');
    if (typeof key === 'string' && key.length === 1 && !hasCommandModifier) {
      wc.sendInputEvent({ type: 'char', keyCode: key, modifiers });
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
  }

  async insertText(text) {
    const value = String(text || '');
    if (!value) return;
    if (typeof this.win?.webContents?.insertText === 'function') {
      await this.win.webContents.insertText(value);
      return;
    }
    this.win.webContents.sendInputEvent({ type: 'char', keyCode: value });
  }

  async moveMouse(x, y) {
    this.win.webContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
  }

  async mouseDown(x, y, { button = 'left', clickCount = 1 } = {}) {
    this.win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount });
  }

  async mouseUp(x, y, { button = 'left', clickCount = 1 } = {}) {
    this.win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount });
  }

  async setFileInputFiles(files) {
    const wc = this.win.webContents;
    const didAttach = !wc.debugger.isAttached();
    try {
      if (didAttach) wc.debugger.attach('1.3');
    } catch {
      const err = new Error('file_upload_unavailable');
      err.data = { reason: 'debugger_attach_failed' };
      throw err;
    }

    try {
      let lastNodeIds = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: 12, pierce: true });
        const q = await wc.debugger.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"]' });
        const nodeIds = Array.isArray(q?.nodeIds) ? q.nodeIds : [];
        lastNodeIds = nodeIds;
        if (!nodeIds.length) {
          await new Promise((resolve) => setTimeout(resolve, 180));
          continue;
        }

        let lastErr = null;
        for (const nodeId of [...nodeIds].reverse()) {
          try {
            await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files });
            lastErr = null;
            break;
          } catch (error) {
            lastErr = error;
          }
        }
        if (!lastErr) return;
        await new Promise((resolve) => setTimeout(resolve, 180));
      }

      const err = new Error('missing_file_input');
      err.data = { selector: 'input[type=file]', found: lastNodeIds.length };
      throw err;
    } finally {
      try {
        if (didAttach && wc.debugger.isAttached()) wc.debugger.detach();
      } catch {}
    }
  }
}

class ElectronPresenter {
  constructor(win) {
    this.win = win;
  }

  isClosed() {
    return this.win?.isDestroyed?.();
  }

  isMinimized() {
    return !!this.win?.isMinimized?.();
  }

  restore() {
    if (!this.isClosed()) this.win.restore();
  }

  show() {
    if (!this.isClosed()) this.win.show();
  }

  focus() {
    if (!this.isClosed()) this.win.focus();
  }

  minimize() {
    if (!this.isClosed()) this.win.minimize();
  }

  isVisible() {
    return !!this.win?.isVisible?.();
  }

  close() {
    if (!this.isClosed()) this.win.close();
  }
}

export class ElectronBrowserBackend {
  constructor({ windowDefaults, userAgent, popupPolicy, onChanged, BrowserWindowClass = BrowserWindow } = {}) {
    this.windowDefaults = windowDefaults || { width: 1100, height: 800, show: false, title: 'Agentify Desktop' };
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : null;
    this.popupPolicy = typeof popupPolicy === 'function' ? popupPolicy : (() => false);
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.BrowserWindowClass = BrowserWindowClass;
    this.quitting = false;
    this.windows = new Set();
  }

  async start() {
    return {
      kind: 'electron',
      managedProfile: true
    };
  }

  setQuitting(v = true) {
    this.quitting = !!v;
  }

  async createSession({
    url,
    show = false,
    protectedTab = false,
    vendorId = null,
    vendorName = null,
    onClosed
  } = {}) {
    let forceClose = false;
    const win = new this.BrowserWindowClass({
      ...this.windowDefaults,
      show: !!show,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        ...(this.windowDefaults.webPreferences || {})
      }
    });
    trackWindow(this.windows, win);
    if (this.userAgent) {
      try {
        win.webContents.setUserAgent(this.userAgent);
      } catch {}
    }
    win.webContents.on('did-create-window', (childWin) => {
      if (!childWin || childWin.isDestroyed?.()) return;
      trackWindow(this.windows, childWin);
      if (this.userAgent) {
        try {
          childWin.webContents.setUserAgent(this.userAgent);
        } catch {}
      }
    });
    win.webContents.setWindowOpenHandler((details) => {
      let openerUrl = '';
      try {
        openerUrl =
          String(details?.referrer?.url || '').trim() ||
          String(win.webContents.getURL?.() || '').trim() ||
          String(url || '').trim();
      } catch {
        openerUrl = String(url || '').trim();
      }
      const allow = !!this.popupPolicy({
        url: details?.url || '',
        frameName: details?.frameName || '',
        disposition: details?.disposition || '',
        openerUrl,
        vendorId: vendorId || 'chatgpt'
      });
      if (!allow) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 760,
          show: true,
          title: 'Agentify Desktop — Sign in',
          autoHideMenuBar: true,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            ...(this.windowDefaults.webPreferences || {})
          }
        }
      };
    });
    const fixedTitle = `Agentify Desktop${vendorName ? ` — ${vendorName}` : ''}`;
    try {
      win.setTitle(fixedTitle);
      win.on('page-title-updated', (event) => {
        try {
          event.preventDefault();
          win.setTitle(fixedTitle);
        } catch {}
      });
    } catch {}

    win.on('closed', () => {
      onClosed?.();
      this.onChanged?.();
    });
    win.on('close', (event) => {
      if (this.quitting) return;
      if (forceClose) return;
      if (!protectedTab) return;
      try {
        event.preventDefault();
        if (win.isMinimized()) return;
        win.minimize();
      } catch {}
    });

    try {
      await win.loadURL(url);
    } catch (error) {
      try {
        if (!win.isDestroyed?.()) win.destroy?.();
      } catch {}
      throw error;
    }
    this.onChanged?.();
    return {
      page: new ElectronPageAdapter(win),
      presenter: new ElectronPresenter(win),
      close: async () => {
        try {
          this.windows.delete(win);
          forceClose = true;
          win.close();
        } catch {}
      },
      isClosed: () => win.isDestroyed?.() || win.webContents?.isDestroyed?.()
    };
  }

  async dispose() {
    this.quitting = true;
    const wins = Array.from(this.windows);
    this.windows.clear();
    for (const win of wins) {
      try {
        if (!win?.isDestroyed?.()) {
          if (typeof win.close === 'function') win.close();
          else if (typeof win.destroy === 'function') win.destroy();
        }
      } catch {}
    }
  }
}
