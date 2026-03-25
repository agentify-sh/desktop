import test from 'node:test';
import assert from 'node:assert/strict';

import { ElectronBrowserBackend } from '../electron-browser-backend.mjs';

class MockBrowserWindow {
  constructor() {
    this.destroyed = false;
    this.closed = false;
    this.minimized = false;
    this.listeners = new Map();
    this.webContentsListeners = new Map();
    this.webContents = {
      isDestroyed: () => this.destroyed,
      setUserAgent: () => {},
      insertText: async () => {},
      on: (event, handler) => {
        const list = this.webContentsListeners.get(event) || [];
        list.push(handler);
        this.webContentsListeners.set(event, list);
      },
      setWindowOpenHandler: () => {}
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
