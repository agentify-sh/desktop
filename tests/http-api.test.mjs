import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { startHttpApi } from '../http-api.mjs';

async function req({ port, token, method, pth, body, headers = {} }) {
  const res = await fetch(`http://127.0.0.1:${port}${pth}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

test('http-api: health is public and returns serverId', async (t) => {
  const tabs = { listTabs: () => [], ensureTab: async () => 't1', createTab: async () => 't1', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 't',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const { res, data } = await req({ port, method: 'GET', pth: '/health' });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.serverId, 'sid-test');
});

test('http-api: rejects unauthorized', async (t) => {
  const tabs = { listTabs: () => [], ensureTab: async () => 't1', createTab: async () => 't1', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true, url: 'x' })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const { res, data } = await req({ port, method: 'GET', pth: '/status' });
  assert.equal(res.status, 401);
  assert.equal(data.error, 'unauthorized');
});

test('http-api: status returns getStatus output', async (t) => {
  const tabs = { listTabs: () => [], ensureTab: async () => 't1', createTab: async () => 't1', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true, url: 'https://chatgpt.com/', blocked: false })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const { res, data } = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.url, 'https://chatgpt.com/');
});

test('http-api: status invalid tabId returns 404', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't1',
    createTab: async () => 't1',
    closeTab: async () => true,
    getControllerById: () => {
      throw new Error('tab_not_found');
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async ({ tabId }) => {
      void tabId;
      throw new Error('tab_not_found');
    }
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'GET', pth: '/status?tabId=nope' });
  assert.equal(r.res.status, 404);
  assert.equal(r.data.error, 'tab_not_found');
});

test('http-api: body_too_large returns 413', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ readPageText: async () => '' })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const big = 'x'.repeat(2_200_000);
  const res = await fetch(`http://127.0.0.1:${port}/read-page`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ maxChars: 10, pad: big })
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 413);
  assert.equal(data.error, 'body_too_large');
});

test('http-api: tabs list/create/close', async (t) => {
  const created = [];
  const tabs = {
    listTabs: () => created.map((id) => ({ id })),
    ensureTab: async ({ key }) => {
      const id = `tab-${key}`;
      if (!created.includes(id)) created.push(id);
      return id;
    },
    createTab: async () => {
      const id = `tab-${created.length + 1}`;
      created.push(id);
      return id;
    },
    closeTab: async (id) => {
      const idx = created.indexOf(id);
      if (idx >= 0) created.splice(idx, 1);
      return true;
    },
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const l1 = await req({ port, token: 'secret', method: 'GET', pth: '/tabs' });
  assert.equal(l1.res.status, 200);
  assert.deepEqual(l1.data.tabs, []);

  const c1 = await req({ port, token: 'secret', method: 'POST', pth: '/tabs/create', body: { key: 'projA' } });
  assert.equal(c1.data.tabId, 'tab-projA');

  const l2 = await req({ port, token: 'secret', method: 'GET', pth: '/tabs' });
  assert.equal(l2.data.tabs.length, 1);

  const cl = await req({ port, token: 'secret', method: 'POST', pth: '/tabs/close', body: { tabId: 'tab-projA' } });
  assert.equal(cl.res.status, 200);
});

test('http-api: tabs/create returns 409 when max tabs reached', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => {
      throw new Error('max_tabs_reached');
    },
    createTab: async () => {
      throw new Error('max_tabs_reached');
    },
    closeTab: async () => true,
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/tabs/create', body: { key: 'projA' } });
  assert.equal(r.res.status, 409);
  assert.equal(r.data.error, 'max_tabs_reached');
});

test('http-api: show creates missing key tab (and hide does not)', async (t) => {
  const created = [];
  const tabs = {
    listTabs: () => created.map((id) => ({ id, key: id.replace(/^tab-/, '') })),
    ensureTab: async ({ key }) => {
      const id = `tab-${key}`;
      if (!created.includes(id)) created.push(id);
      return id;
    },
    createTab: async () => {
      const id = `tab-${created.length + 1}`;
      created.push(id);
      return id;
    },
    closeTab: async () => true,
    getControllerById: () => ({})
  };

  let shown = [];
  let hidden = [];
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    onShow: async ({ tabId }) => shown.push(tabId),
    onHide: async ({ tabId }) => hidden.push(tabId),
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  // show should create
  const s1 = await req({ port, token: 'secret', method: 'POST', pth: '/show', body: { key: 'projA' } });
  assert.equal(s1.res.status, 200);
  assert.equal(created.includes('tab-projA'), true);
  assert.deepEqual(shown.includes('tab-projA'), true);

  // hide should NOT create
  const h1 = await req({ port, token: 'secret', method: 'POST', pth: '/hide', body: { key: 'projB' } });
  assert.equal(h1.res.status, 404);
  assert.equal(h1.data.error, 'tab_not_found');
  assert.equal(created.includes('tab-projB'), false);

  // hide should work for existing
  const h2 = await req({ port, token: 'secret', method: 'POST', pth: '/hide', body: { key: 'projA' } });
  assert.equal(h2.res.status, 200);
  assert.deepEqual(hidden.includes('tab-projA'), true);
});

test('http-api: operations run through controller.runExclusive when available', async (t) => {
  let inExclusive = false;
  const calls = [];
  const controller = {
    runExclusive: async (fn) => {
      assert.equal(inExclusive, false);
      inExclusive = true;
      try {
        return await fn();
      } finally {
        inExclusive = false;
      }
    },
    navigate: async () => {
      assert.equal(inExclusive, true);
      calls.push('navigate');
    },
    ensureReady: async () => {
      assert.equal(inExclusive, true);
      calls.push('ensureReady');
      return { ok: true };
    },
    query: async () => {
      assert.equal(inExclusive, true);
      calls.push('query');
      return { text: 'ok' };
    },
    readPageText: async () => {
      assert.equal(inExclusive, true);
      calls.push('readPageText');
      return 'page';
    },
    downloadLastAssistantImages: async () => {
      assert.equal(inExclusive, true);
      calls.push('downloadLastAssistantImages');
      return [];
    },
    getUrl: async () => 'https://chatgpt.com/'
  };

  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  await req({ port, token: 'secret', method: 'POST', pth: '/navigate', body: { url: 'https://chatgpt.com/' } });
  await req({ port, token: 'secret', method: 'POST', pth: '/ensure-ready', body: { timeoutMs: 1000 } });
  await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi' } });
  await req({ port, token: 'secret', method: 'POST', pth: '/read-page', body: { maxChars: 10 } });
  await req({ port, token: 'secret', method: 'POST', pth: '/download-images', body: { maxImages: 1 } });

  assert.deepEqual(calls, ['navigate', 'ensureReady', 'query', 'readPageText', 'downloadLastAssistantImages']);
});

test('http-api: ensure-ready timeout maps to 408 with details', async (t) => {
  const controller = {
    runExclusive: async (fn) => await fn(),
    ensureReady: async () => {
      const err = new Error('timeout_waiting_for_prompt');
      err.data = { kind: 'login' };
      throw err;
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/ensure-ready', body: { timeoutMs: 1000 } });
  assert.equal(r.res.status, 408);
  assert.equal(r.data.error, 'timeout_waiting_for_prompt');
  assert.deepEqual(r.data.data, { kind: 'login' });
});

test('http-api: query returns 429 when maxInflightQueries exceeded', async (t) => {
  let started = 0;
  let release;
  const gate = new Promise((r) => (release = r));

  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      started += 1;
      await gate;
      return { text: 'ok' };
    }
  };

  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };

  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true }),
    getSettings: async () => ({ maxInflightQueries: 1, maxQueriesPerMinute: 999, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const q1 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi' } });
  // Give the server a moment to enter the handler and increment inflight.
  for (let i = 0; i < 50 && started === 0; i++) await new Promise((r) => setTimeout(r, 5));

  const q2 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi2' } });
  assert.equal(q2.res.status, 429);
  assert.equal(q2.data.error, 'rate_limited');
  assert.equal(q2.data.reason, 'max_inflight');

  release();
  const q1r = await q1;
  assert.equal(q1r.res.status, 200);
});

test('http-api: query pacing returns 429 with retryAfterMs when max wait is 0', async (t) => {
  let calls = 0;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      calls += 1;
      return { text: 'ok' };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true }),
    getSettings: async () => ({ maxInflightQueries: 10, maxQueriesPerMinute: 999, minTabGapMs: 5_000, minGlobalGapMs: 0, showTabsByDefault: false })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const q1 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi' } });
  assert.equal(q1.res.status, 200);

  const q2 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi2' } });
  assert.equal(q2.res.status, 429);
  assert.equal(q2.data.error, 'rate_limited');
  assert.equal(q2.data.reason, 'tab_gap');
  assert.equal(typeof q2.data.retryAfterMs, 'number');
  assert.ok(q2.data.retryAfterMs > 0);

  assert.equal(calls, 1);
});

test('http-api: invalid tabId returns 404', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => {
      throw new Error('tab_not_found');
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/read-page', body: { tabId: 'nope', maxChars: 10 } });
  assert.equal(r.res.status, 404);
  assert.equal(r.data.error, 'tab_not_found');
});

test('http-api: default tab cannot be closed', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/tabs/close', body: { tabId: 't0' } });
  assert.equal(r.res.status, 409);
  assert.equal(r.data.error, 'default_tab_protected');
});

test('http-api: tab_closed returns 409', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => {
      throw new Error('tab_closed');
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/read-page', body: { tabId: 't0', maxChars: 10 } });
  assert.equal(r.res.status, 409);
  assert.equal(r.data.error, 'tab_closed');
});

test('http-api: rotate-token updates auth', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-state-'));
  const tabs = { listTabs: () => [], ensureTab: async () => 't0', createTab: async () => 't0', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 'old',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r1 = await req({ port, token: 'old', method: 'POST', pth: '/rotate-token' });
  assert.equal(r1.res.status, 200);

  const r2 = await req({ port, token: 'old', method: 'GET', pth: '/status' });
  assert.equal(r2.res.status, 401);
});

test('http-api: shutdown calls onShutdown', async (t) => {
  let called = 0;
  const tabs = { listTabs: () => [], ensureTab: async () => 't0', createTab: async () => 't0', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    onShutdown: async () => {
      called += 1;
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/shutdown', body: { scope: 'app' } });
  assert.equal(r.res.status, 200);
  assert.equal(r.data.ok, true);

  // Give the async handler a moment.
  await new Promise((r2) => setTimeout(r2, 10));
  assert.equal(called, 1);
});

test('http-api: query rate limits (qpm + inflight)', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({
      query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
    })
  };

  let inflightBlock = false;
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true }),
    getSettings: async () => {
      if (inflightBlock) return { maxInflightQueries: 1, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false };
      return { maxInflightQueries: 2, maxQueriesPerMinute: 1, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false };
    }
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r1 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi', attachments: [] } });
  assert.equal(r1.res.status, 200);

  const r2 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi2', attachments: [] } });
  assert.equal(r2.res.status, 429);
  assert.equal(r2.data.error, 'rate_limited');
  assert.equal(r2.data.reason, 'qpm');

  // Inflight: simulate by having controller.query hang while maxInflightQueries=1.
  inflightBlock = true;
  let resolveHang;
  const hang = new Promise((r) => (resolveHang = r));
  tabs.getControllerById = () => ({
    query: async () => {
      await hang;
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  });

  const p1 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'a', attachments: [] } });
  // Let the first request enter inflight.
  await new Promise((r) => setTimeout(r, 20));
  const p2 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'b', attachments: [] } });

  const p2Res = await p2;
  assert.equal(p2Res.res.status, 429);
  assert.equal(p2Res.data.reason, 'max_inflight');

  resolveHang();
  const p1Res = await p1;
  assert.equal(p1Res.res.status, 200);
});

test('http-api: send uses governor too', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({
      send: async () => ({ ok: true })
    })
  };

  let qpm = 1;
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true }),
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: qpm, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r1 = await req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'hi', stopAfterSend: true } });
  assert.equal(r1.res.status, 200);

  // Immediately sending again should trip qpm=1.
  const r2 = await req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'hi2' } });
  assert.equal(r2.res.status, 429);
  assert.equal(r2.data.reason, 'qpm');

  // Increase qpm and ensure the bucket adjusts.
  qpm = 100;
  const r3 = await req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'hi3' } });
  assert.equal(r3.res.status, 200);
});
