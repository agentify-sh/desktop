import test from 'node:test';
import assert from 'node:assert/strict';

import { ElectronBrowserBackend } from '../electron-browser-backend.mjs';
import { shouldAllowPopup } from '../popup-policy.mjs';

class MockBrowserWindow {
  constructor() {
    this.destroyed = false;
    this.closed = false;
    this.minimized = false;
    this.url = '';
    this.listeners = new Map();
    this.webContentsListeners = new Map();
    this.windowOpenHandler = null;
    this.webContents = {
      isDestroyed: () => this.destroyed,
      setUserAgent: () => {},
      insertText: async () => {},
      getURL: () => this.url,
      on: (event, handler) => {
        const list = this.webContentsListeners.get(event) || [];
        list.push(handler);
        this.webContentsListeners.set(event, list);
      },
      setWindowOpenHandler: (handler) => {
        this.windowOpenHandler = handler;
      }
    };
  }

  on(event, handler) {
    const list = this.listeners.get(event) || [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  async loadURL() {
    throw new Error('load_failed');
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
  }

  close() {
    const closeHandlers = this.listeners.get('close') || [];
    let prevented = false;
    const event = {
      preventDefault() {
        prevented = true;
      }
    };
    for (const handler of closeHandlers) handler(event);
    if (prevented) return;
    this.closed = true;
    this.destroyed = true;
    const closedHandlers = this.listeners.get('closed') || [];
    for (const handler of closedHandlers) handler();
  }

  isMinimized() {
    return this.minimized;
  }

  minimize() {
    this.minimized = true;
  }

  setTitle() {}

  emitWebContents(event, ...args) {
    const handlers = this.webContentsListeners.get(event) || [];
    for (const handler of handlers) handler(...args);
  }
}

test('electron-browser-backend: createSession destroys window if loadURL fails', async () => {
  let createdWindow = null;
  class TestBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: TestBrowserWindow
  });

  await assert.rejects(
    async () => await backend.createSession({ url: 'https://chatgpt.com/' }),
    /load_failed/
  );
  assert.equal(createdWindow?.destroyed, true);
});

test('electron-browser-backend: dispose closes tracked windows', async () => {
  const created = [];
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      created.push(this);
    }

    async loadURL() {
      return true;
    }

    isMinimized() {
      return false;
    }

    minimize() {}
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  await backend.createSession({ url: 'https://chatgpt.com/' });
  await backend.createSession({ url: 'https://claude.ai/' });
  assert.equal(created.length, 2);

  await backend.dispose();

  assert.equal(created.every((win) => win.closed), true);
  assert.equal(backend.windows.size, 0);
});

test('electron-browser-backend: session.close closes protected tabs instead of minimizing them', async () => {
  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/', protectedTab: true });
  await session.close();

  assert.equal(createdWindow?.closed, true);
  assert.equal(createdWindow?.destroyed, true);
  assert.equal(createdWindow?.minimized, false);
});

test('electron-browser-backend: dispose closes tracked auth popup child windows too', async () => {
  const created = [];
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      created.push(this);
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  await backend.createSession({ url: 'https://chatgpt.com/' });
  const parent = created[0];
  const child = new OkBrowserWindow();
  parent.emitWebContents('did-create-window', child);

  await backend.dispose();

  assert.equal(parent.closed, true);
  assert.equal(child.closed, true);
  assert.equal(backend.windows.size, 0);
});

test('electron-browser-backend: forwards opener context (url, frameName, disposition, openerUrl, vendorId) to popupPolicy', async () => {
  let capturedDetails = null;
  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL(url) {
      this.url = url;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow,
    popupPolicy: (details) => {
      capturedDetails = details;
      return false;
    }
  });

  await backend.createSession({ url: 'https://chatgpt.com/auth/login', vendorId: 'chatgpt' });
  assert.equal(typeof createdWindow.windowOpenHandler, 'function');

  const result = createdWindow.windowOpenHandler({
    url: 'about:blank',
    frameName: 'oauth_popup',
    disposition: 'new-window',
    referrer: { url: 'https://chatgpt.com/auth/login' }
  });

  assert.deepEqual(result, { action: 'deny' });
  assert.ok(capturedDetails, 'popupPolicy should have been called');
  assert.equal(capturedDetails.url, 'about:blank');
  assert.equal(capturedDetails.frameName, 'oauth_popup');
  assert.equal(capturedDetails.disposition, 'new-window');
  assert.equal(capturedDetails.openerUrl, 'https://chatgpt.com/auth/login');
  assert.equal(capturedDetails.vendorId, 'chatgpt');
});

test('electron-browser-backend: about:blank Google SSO pre-open from ChatGPT is allowed via real popup policy (regression for #11)', async () => {
  // Mirror the wrapper used in main.mjs: spread all details into shouldAllowPopup.
  const popupPolicy = (details) =>
    shouldAllowPopup({
      ...details,
      allowAuthPopups: true
    });

  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL(url) {
      this.url = url;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow,
    popupPolicy
  });

  await backend.createSession({ url: 'https://chatgpt.com/auth/login', vendorId: 'chatgpt' });

  // ChatGPT's "Continue with Google" first opens an about:blank popup, then navigates
  // it to accounts.google.com. If the wrapper drops openerUrl/frameName/disposition,
  // shouldAllowPopup would deny the about:blank pre-open and SSO breaks.
  const result = createdWindow.windowOpenHandler({
    url: 'about:blank',
    frameName: 'oauth_popup',
    disposition: 'new-window',
    referrer: { url: 'https://chatgpt.com/auth/login' }
  });

  assert.equal(result?.action, 'allow');

  // Subsequent direct https://accounts.google.com popup must also be allowed.
  const direct = createdWindow.windowOpenHandler({
    url: 'https://accounts.google.com/signin/v2/identifier',
    frameName: '',
    disposition: 'new-window',
    referrer: { url: 'https://chatgpt.com/auth/login' }
  });
  assert.equal(direct?.action, 'allow');

  // An untrusted opener trying to ride the same path must still be denied.
  const blocked = createdWindow.windowOpenHandler({
    url: 'about:blank',
    frameName: 'oauth_popup',
    disposition: 'new-window',
    referrer: { url: 'https://evil.example.com/' }
  });
  assert.deepEqual(blocked, { action: 'deny' });
});

test('electron-browser-backend: insertText uses native webContents.insertText when available', async () => {
  let inserted = '';
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      this.webContents.insertText = async (value) => {
        inserted += value;
      };
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  await session.page.insertText('hello');

  assert.equal(inserted, 'hello');
});
