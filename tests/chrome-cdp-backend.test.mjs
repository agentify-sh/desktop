import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { ChromeCdpBrowserBackend, ChromeCdpConnection, findAvailablePort } from '../chrome-cdp-backend.mjs';

class MockWebSocket {
  constructor() {
    this.listeners = new Map();
    queueMicrotask(() => this.#emit('open', {}));
  }

  addEventListener(type, handler, opts = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: !!opts?.once });
    this.listeners.set(type, list);
  }

  send(_payload) {}

  close() {
    queueMicrotask(() => this.#emit('close', {}));
  }

  #emit(type, event) {
    const list = [...(this.listeners.get(type) || [])];
    for (const item of list) {
      try {
        item.handler(event);
      } catch {}
    }
    const keep = (this.listeners.get(type) || []).filter((item) => !item.once);
    if (keep.length) this.listeners.set(type, keep);
    else this.listeners.delete(type);
  }
}

class DelayedMockWebSocket {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler, opts = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: !!opts?.once });
    this.listeners.set(type, list);
  }

  send(_payload) {}

  close() {
    queueMicrotask(() => this.#emit('close', {}));
  }

  open() {
    queueMicrotask(() => this.#emit('open', {}));
  }

  #emit(type, event) {
    const list = [...(this.listeners.get(type) || [])];
    for (const item of list) {
      try {
        item.handler(event);
      } catch {}
    }
    const keep = (this.listeners.get(type) || []).filter((item) => !item.once);
    if (keep.length) this.listeners.set(type, keep);
    else this.listeners.delete(type);
  }
}

test('chrome-cdp-backend: findAvailablePort returns a valid port number', async () => {
  const port = await findAvailablePort();
  assert.equal(typeof port, 'number');
  assert.ok(port > 0 && port < 65536);
});

test('chrome-cdp-backend: start auto-selects available port when default is occupied', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-chrome-port-auto-'));
  const scriptPath = path.join(tmpDir, 'fake-chrome-mock.sh');
  await fs.writeFile(scriptPath, '#!/bin/sh\nsleep 30\n', { encoding: 'utf8', mode: 0o755 });

  const backend = new ChromeCdpBrowserBackend({
    stateDir: tmpDir,
    executablePath: scriptPath,
    debugPort: 9222
  });
  backend.startupTimeoutMs = 1000;
  backend.startupPollMs = 50;

  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  let fetchCalls = 0;
  globalThis.fetch = async (url) => {
    // Return success for port 9222 so start() detects it as occupied
    if (url.includes('9222')) {
      return { ok: true, async json() { return {}; } };
    }
    fetchCalls += 1;
    if (fetchCalls <= 2) throw new Error('not_ready_yet');
    return {
      ok: true,
      async json() {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:45992/devtools/browser/test' };
      }
    };
  };
  globalThis.WebSocket = class {
    constructor() {}
    addEventListener(type, handler) {
      if (type === 'open') queueMicrotask(() => handler({}));
    }
    close() {}
  };

  try {
    await backend.start();
    assert.notEqual(backend.debugPort, 9222, 'should have switched away from occupied port 9222');
    assert.ok(backend.debugPort > 0 && backend.debugPort < 65536);
    assert.equal(backend.started, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
    await backend.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('chrome-cdp-backend: pending commands reject when websocket closes', async () => {
  const ws = new MockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  await conn.connect();
  const pending = conn.send('Runtime.evaluate', { expression: '1+1' });
  ws.close();

  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: connect rejects if websocket closes before open', async () => {
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ({
      addEventListener(type, handler) {
        if (type === 'close') queueMicrotask(() => handler({}));
      },
      close() {}
    })
  });

  await assert.rejects(async () => await conn.connect(), /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: async connect error clears stale websocket before retry', async () => {
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) {
        return {
          addEventListener(type, handler) {
            if (type === 'error') queueMicrotask(() => handler(new Error('ws_async_failed')));
          },
          close() {}
        };
      }
      return new MockWebSocket();
    }
  });

  await assert.rejects(async () => await conn.connect(), /ws_async_failed/);
  assert.equal(conn.ws, null);
  await conn.connect();
  assert.equal(calls, 2);
});

test('chrome-cdp-backend: concurrent connect calls share one websocket', async () => {
  let created = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      created += 1;
      return new MockWebSocket();
    }
  });

  await Promise.all([conn.connect(), conn.connect(), conn.connect()]);
  assert.equal(created, 1);
});

test('chrome-cdp-backend: synchronous websocket constructor failure does not poison future retries', async () => {
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) throw new Error('ws_ctor_failed');
      return new MockWebSocket();
    }
  });

  await (async () => {
    try {
      await conn.connect();
      assert.fail('expected first connect to fail');
    } catch (error) {
      assert.match(String(error?.message || error), /ws_ctor_failed/);
    }
  })();
  await conn.connect();
  assert.equal(calls, 2);
});

test('chrome-cdp-backend: close cancels an in-flight connect before open', async () => {
  const ws = new DelayedMockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  const pending = conn.connect();
  await conn.close();
  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: late open after cancel does not resurrect connection state', async () => {
  const ws = new DelayedMockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  const pending = conn.connect();
  await conn.close();
  ws.open();
  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
  assert.equal(conn.connected, false);
  assert.equal(conn.ws, null);
});

test('chrome-cdp-backend: stale socket close does not tear down a newer healthy connection', async () => {
  const first = new DelayedMockWebSocket();
  let second = null;
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) return first;
      second = new MockWebSocket();
      return second;
    }
  });

  const pendingFirst = conn.connect();
  await conn.close();
  await assert.rejects(async () => await pendingFirst, /chrome_cdp_disconnected/);

  await conn.connect();
  assert.equal(conn.connected, true);
  assert.equal(conn.ws, second);

  first.close();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(conn.connected, true);
  assert.equal(conn.ws, second);
});

test('chrome-cdp-backend: createSession closes target if initialization fails', async () => {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Page.enable') throw new Error('page_enable_failed');
      if (method === 'Target.closeTarget') return { success: true };
      return {};
    }
  };

  await assert.rejects(
    async () => await backend.createSession({ url: 'https://chatgpt.com/' }),
    /page_enable_failed/
  );

  assert.equal(calls.some((item) => item.method === 'Target.closeTarget' && item.params?.targetId === 'target-1'), true);
});

test('chrome-cdp-backend: session close is best-effort when closeTarget fails', async () => {
  let closedCalls = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      void params;
      void sessionId;
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Target.closeTarget') throw new Error('chrome_cdp_disconnected');
      return {};
    }
  };

  const session = await backend.createSession({
    url: 'https://chatgpt.com/',
    onClosed: () => {
      closedCalls += 1;
    }
  });

  await session.close();
  assert.equal(session.isClosed(), true);
  assert.equal(closedCalls, 1);
});

test('chrome-cdp-backend: start cleans up spawned chrome process when CDP connect fails', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-chrome-start-fail-'));
  const scriptPath = path.join(tmpDir, 'fake-chrome.sh');
  await fs.writeFile(scriptPath, '#!/bin/sh\nsleep 30\n', { encoding: 'utf8', mode: 0o755 });

  const backend = new ChromeCdpBrowserBackend({
    stateDir: tmpDir,
    executablePath: scriptPath,
    debugPort: 45999
  });

  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error('port_not_in_use');
    return {
      ok: true,
      async json() {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:45999/devtools/browser/test' };
      }
    };
  };
  globalThis.WebSocket = class {
    constructor() {
      queueMicrotask(() => {
        this._error?.(new Error('ws_connect_failed'));
      });
    }
    addEventListener(type, handler) {
      if (type === 'error') this._error = handler;
    }
    close() {}
  };

  try {
    await assert.rejects(async () => await backend.start(), /ws_connect_failed/);
    assert.equal(backend.client, null);
    assert.equal(backend.started, false);
    assert.equal(backend.chromeProcess, null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('chrome-cdp-backend: start failure includes actionable diagnostic data (executable, args, debugPort, chromeExitCode, chromeStderr, hint)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-chrome-diag-'));
  const scriptPath = path.join(tmpDir, 'fake-chrome.sh');
  // Fake chrome that prints a diagnostic line to stderr and exits non-zero — it never opens the debug port.
  await fs.writeFile(
    scriptPath,
    '#!/bin/sh\necho "fatal: SUID sandbox helper missing" 1>&2\nexit 127\n',
    { encoding: 'utf8', mode: 0o755 }
  );

  const backend = new ChromeCdpBrowserBackend({
    stateDir: tmpDir,
    executablePath: scriptPath,
    debugPort: 45997
  });

  const originalFetch = globalThis.fetch;
  // Always reject the /json/version probe so the start loop times out.
  globalThis.fetch = async () => {
    throw new Error('port_not_in_use');
  };

  try {
    backend.startupTimeoutMs = 600;
    backend.startupPollMs = 100;
    let captured = null;
    try {
      await backend.start();
      assert.fail('expected start() to reject');
    } catch (error) {
      captured = error;
    }
    assert.equal(captured?.message, 'chrome_cdp_unavailable');
    const data = captured?.data || {};
    assert.equal(data.executable, scriptPath);
    assert.equal(data.debugPort, 45997);
    assert.ok(Array.isArray(data.args) && data.args.includes('--remote-debugging-port=45997'),
      `expected launch args in error.data.args, got: ${JSON.stringify(data.args)}`);
    assert.equal(typeof data.hint, 'string');
    assert.ok(data.hint.length > 0, 'expected non-empty hint');
    assert.equal(data.chromeExitCode, 127, `expected captured exit code 127, got ${data.chromeExitCode}`);
    assert.ok(typeof data.chromeStderr === 'string' && data.chromeStderr.includes('SUID sandbox helper missing'),
      `expected captured stderr, got: ${JSON.stringify(data.chromeStderr)}`);
    assert.equal(backend.chromeProcess, null);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('chrome-cdp-backend: dispose resets started state and clears stale tab closers', async () => {
  let clientClosed = 0;
  let processKilled = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    close: async () => {
      clientClosed += 1;
    }
  };
  backend.chromeProcess = {
    killed: false,
    kill: () => {
      processKilled += 1;
    }
  };
  backend.tabClosers.set('tab-1', () => {});
  backend.boundTargetDestroyed = () => {};

  await backend.dispose();

  assert.equal(clientClosed, 1);
  assert.equal(processKilled, 1);
  assert.equal(backend.started, false);
  assert.equal(backend.tabClosers.size, 0);
  assert.equal(backend.client, null);
  assert.equal(backend.chromeProcess, null);
  assert.equal(backend.boundTargetDestroyed, null);
});

test('chrome-cdp-backend: start does not reuse a disconnected client as healthy state', async () => {
  let connectCalls = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: false,
    ws: null,
    close: async () => {}
  };
  backend.chromeProcess = {
    killed: false,
    kill: () => {}
  };
  backend.boundTargetDestroyed = () => {};

  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error('port_not_in_use');
    return {
      ok: true,
      async json() {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:45998/devtools/browser/test' };
      }
    };
  };
  globalThis.WebSocket = class {
    constructor() {}
    addEventListener(type, handler) {
      if (type === 'open') {
        connectCalls += 1;
        queueMicrotask(() => handler({}));
      }
    }
    close() {}
  };

  try {
    await backend.start();
    assert.equal(connectCalls, 1);
    assert.equal(backend.started, true);
    assert.equal(backend.client?.connected, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
    await backend.dispose();
  }
});
