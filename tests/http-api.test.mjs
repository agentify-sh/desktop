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

test('http-api: status surfaces active query runtime and stop can cancel it', async (t) => {
  let releaseQuery = null;
  let stopCalls = 0;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      await new Promise((_, reject) => {
        releaseQuery = () => {
          const err = new Error('query_aborted');
          err.data = { reason: 'user_stop' };
          reject(err);
        };
      });
    },
    requestStop: async () => {
      stopCalls += 1;
      releaseQuery?.();
      return { ok: true, requested: true, clicked: true };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
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
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, url: 'https://chatgpt.com/', blocked: false, promptVisible: true, kind: null, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const qPromise = req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'hello from control center' }
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const st1 = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st1.res.status, 200);
  assert.equal(st1.data.activeQuery?.tabId, 't0');
  assert.equal(st1.data.activeQuery?.kind, 'query');
  assert.match(st1.data.activeQuery?.promptPreview || '', /hello from control center/);
  assert.equal(st1.data.runtime?.activeQueries?.length, 1);

  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  assert.equal(stop.res.status, 200);
  assert.equal(stop.data.requested, true);
  assert.equal(stop.data.clicked, true);
  assert.equal(stop.data.activeQuery?.stopRequested, true);

  const qRes = await qPromise;
  assert.equal(qRes.res.status, 409);
  assert.equal(qRes.data.error, 'query_aborted');
  assert.equal(stopCalls, 1);

  const st2 = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st2.res.status, 200);
  assert.equal(st2.data.activeQuery, null);
  assert.equal(st2.data.runtime?.activeQueries?.length, 0);
});

test('http-api: status surfaces source, phase, blocked state, and last outcome for runs', async (t) => {
  let releaseQuery = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async ({ onProgress }) => {
      await onProgress?.({ phase: 'typing_prompt' });
      await onProgress?.({ phase: 'awaiting_user', blocked: true, blockedKind: 'login', blockedTitle: 'Needs sign-in' });
      await new Promise((resolve) => {
        releaseQuery = resolve;
      });
      await onProgress?.({ phase: 'waiting_for_response', blocked: false, blockedKind: null, blockedTitle: null });
      return { text: 'final answer', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
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
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, url: 'https://chatgpt.com/', blocked: false, promptVisible: true, kind: null, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const qPromise = req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'show runtime', source: 'mcp' }
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const st1 = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st1.res.status, 200);
  assert.equal(st1.data.activeQuery?.source, 'mcp');
  assert.equal(st1.data.activeQuery?.phase, 'awaiting_user');
  assert.equal(st1.data.activeQuery?.blocked, true);
  assert.equal(st1.data.activeQuery?.blockedKind, 'login');
  assert.equal(st1.data.activeQuery?.blockedTitle, 'Needs sign-in');

  releaseQuery?.();
  const qRes = await qPromise;
  assert.equal(qRes.res.status, 200);

  const st2 = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st2.res.status, 200);
  assert.equal(st2.data.activeQuery, null);
  assert.equal(st2.data.runtime?.lastOutcomes?.[0]?.tabId, 't0');
  assert.equal(st2.data.runtime?.lastOutcomes?.[0]?.status, 'success');
  assert.equal(st2.data.runtime?.lastOutcomes?.[0]?.source, 'mcp');
  assert.equal(st2.data.runtime?.lastOutcomes?.[0]?.label, 'Response received');
});

test('http-api: same-tab query/send requests are rejected while a run is already active', async (t) => {
  let releaseQuery = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      await new Promise((resolve) => {
        releaseQuery = resolve;
      });
      return { text: 'done', codeBlocks: [], meta: {} };
    },
    send: async () => ({ ok: true })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
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
    getSettings: async () => ({ maxInflightQueries: 5, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, url: 'https://chatgpt.com/', blocked: false, promptVisible: true, kind: null, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const q1 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'first' } });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const q2 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'second' } });
  assert.equal(q2.res.status, 409);
  assert.equal(q2.data.error, 'tab_busy');
  assert.equal(q2.data.data?.activeQuery?.promptPreview, 'first');

  const s2 = await req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'third' } });
  assert.equal(s2.res.status, 409);
  assert.equal(s2.data.error, 'tab_busy');

  const st = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st.res.status, 200);
  assert.equal(st.data.runtime?.activeQueries?.length, 1);

  releaseQuery?.();
  const q1Res = await q1;
  assert.equal(q1Res.res.status, 200);

  const st2 = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st2.res.status, 200);
  assert.equal(st2.data.runtime?.activeQueries?.length, 0);
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

test('http-api: status routes key/model selectors to the requested vendor tab', async (t) => {
  const seenStatus = [];
  const tabs = {
    listTabs: () => [
      { id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' },
      { id: 't1', key: 'compare', vendorId: 'claude', vendorName: 'Claude', url: 'https://claude.ai/' }
    ],
    ensureTab: async () => 't1',
    createTab: async () => 't1',
    closeTab: async () => true,
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
    ],
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async ({ tabId }) => {
      seenStatus.push(tabId);
      return { ok: true, tabId, url: 'https://claude.ai/' };
    }
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'GET',
    pth: '/status?key=compare&model=claude'
  });
  assert.equal(r.res.status, 200);
  assert.equal(r.data.tabId, 't1');
  assert.deepEqual(seenStatus, ['t1']);
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

test('http-api: invalid JSON returns 400', async (t) => {
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

  const res = await fetch(`http://127.0.0.1:${port}/read-page`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: '{"maxChars":10'
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 400);
  assert.equal(data.error, 'invalid_json');
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

test('http-api: tabs/create routes keyed tabs to the requested vendor', async (t) => {
  let ensuredArgs = null;
  const tabs = {
    listTabs: () => [],
    ensureTab: async (args) => {
      ensuredArgs = args;
      return 'tab-claude-proj';
    },
    createTab: async () => 'tab-x',
    closeTab: async () => true,
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
    ],
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/tabs/create',
    body: { key: 'projA', vendorId: 'claude' }
  });
  assert.equal(r.res.status, 200);
  assert.equal(ensuredArgs.key, 'projA');
  assert.equal(ensuredArgs.vendorId, 'claude');
  assert.equal(ensuredArgs.vendorName, 'Claude');
  assert.equal(ensuredArgs.url, 'https://claude.ai/');
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

test('http-api: query packs context paths before forwarding to controller', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-context-'));
  await fs.writeFile(path.join(dir, 'repo.txt'), 'hello from repo\n', 'utf8');
  await fs.writeFile(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

  let seen = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async (args) => {
      seen = args;
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'Summarize this project.', contextPaths: [dir], attachments: [] }
  });

  assert.equal(r.res.status, 200);
  assert.match(String(seen?.prompt || ''), /Packed Context Summary/);
  assert.ok(Array.isArray(seen?.attachments));
  assert.ok(seen.attachments.some((p) => p.endsWith('image.png')));
  assert.equal(r.data.packedContext.filesScanned >= 2, true);
  assert.equal(r.data.packedContextSummary.inlineFileCount >= 1, true);
  assert.equal(r.data.packedContextSummary.autoAttachmentCount >= 1, true);
  assert.equal(r.data.packedContextSummary.contextCharsUsed >= 1, true);
});

test('http-api: query merges saved bundle inputs', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-bundle-'));
  const bundleText = path.join(dir, 'bundle.txt');
  const extraText = path.join(dir, 'extra.txt');
  const art = path.join(dir, 'sprite.png');
  await fs.writeFile(bundleText, 'bundle content\n', 'utf8');
  await fs.writeFile(extraText, 'extra content\n', 'utf8');
  await fs.writeFile(art, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

  let seen = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async (args) => {
      seen = args;
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const savedBundle = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/save',
    body: {
      name: 'repo-review',
      promptPrefix: 'Use the saved review style.',
      attachments: [art],
      contextPaths: [bundleText]
    }
  });
  assert.equal(savedBundle.res.status, 200);

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: {
      prompt: 'Now answer my question.',
      bundleName: 'repo-review',
      promptPrefix: 'Also be brief.',
      contextPaths: [extraText]
    }
  });

  assert.equal(r.res.status, 200);
  assert.match(String(seen?.prompt || ''), /Use the saved review style\./);
  assert.match(String(seen?.prompt || ''), /Also be brief\./);
  assert.match(String(seen?.prompt || ''), /bundle\.txt/);
  assert.match(String(seen?.prompt || ''), /extra\.txt/);
  assert.ok(seen.attachments.some((p) => p.endsWith('sprite.png')));
  assert.equal(r.data.bundle.name, 'repo-review');
});

test('http-api: query with keyed tab uses default vendor metadata when no model is provided', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-default-vendor-key-'));
  let ensuredArgs = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [],
    ensureTab: async (args) => {
      ensuredArgs = args;
      return 't-chatgpt';
    },
    createTab: async () => 't-chatgpt',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
    ],
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { key: 'projA', prompt: 'hi' }
  });

  assert.equal(r.res.status, 200);
  assert.equal(ensuredArgs.key, 'projA');
  assert.equal(ensuredArgs.vendorId, 'chatgpt');
  assert.equal(ensuredArgs.vendorName, 'ChatGPT');
  assert.equal(ensuredArgs.url, 'https://chatgpt.com/');
});

test('http-api: bundle save/list/get/delete work', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-bundles-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/save',
    body: { name: 'repo-review', promptPrefix: 'Review carefully.' }
  });
  assert.equal(saved.res.status, 200);

  const listed = await req({ port, token: 'secret', method: 'GET', pth: '/bundles/list' });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.bundles.length, 1);

  const got = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/get',
    body: { name: 'repo-review' }
  });
  assert.equal(got.res.status, 200);
  assert.equal(got.data.bundle.name, 'repo-review');

  const deleted = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/delete',
    body: { name: 'repo-review' }
  });
  assert.equal(deleted.res.status, 200);
  assert.equal(deleted.data.deleted, true);
});

test('http-api: bundles/save rejects relative local paths on the direct HTTP surface', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-bundles-relative-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
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
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/save',
    body: { name: 'repo-review', attachments: ['./relative.txt'] }
  });
  assert.equal(saved.res.status, 400);
  assert.equal(saved.data.error, 'relative_path_not_allowed');
  assert.equal(saved.data.data?.field, 'attachments');
});

test('http-api: query returns 404 for missing bundle', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-bundle-missing-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'hello', bundleName: 'missing' }
  });
  assert.equal(resp.res.status, 404);
  assert.equal(resp.data.error, 'bundle_not_found');
});

test('http-api: get bundle returns 404 when missing', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-bundle-get-missing-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/get',
    body: { name: 'missing' }
  });
  assert.equal(resp.res.status, 404);
  assert.equal(resp.data.error, 'bundle_not_found');
});

test('http-api: query returns 400 for missing context path', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-context-missing-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'Summarize this project.', contextPaths: [path.join(dir, 'nope')] }
  });

  assert.equal(r.res.status, 400);
  assert.equal(r.data.error, 'missing_context_path');
});

test('http-api: query returns 400 for missing explicit attachment path', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-missing-attach-'));
  const missing = path.join(dir, 'missing.png');
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'hi', attachments: [missing] }
  });

  assert.equal(r.res.status, 400);
  assert.equal(r.data.error, 'missing_attachment_path');
});

test('http-api: query rejects relative local paths on the direct HTTP surface', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-query-relative-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'hi', attachments: ['./relative.txt'] }
  });

  assert.equal(r.res.status, 400);
  assert.equal(r.data.error, 'relative_path_not_allowed');
  assert.equal(r.data.data?.field, 'attachments');
});

test('http-api: invalid query input does not consume rate-limit budget', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-budget-validation-'));
  const missing = path.join(dir, 'missing.txt');
  let queries = 0;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      queries += 1;
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
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
    stateDir: dir,
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 1, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const bad = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'bad', attachments: [missing] }
  });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.data.error, 'missing_attachment_path');

  const good = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'good', attachments: [] }
  });
  assert.equal(good.res.status, 200);
  assert.equal(queries, 1);
});

test('http-api: artifacts save/list/open-folder work', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-'));
  let opened = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantImages: async ({ outDir }) => {
      const filePath = path.join(outDir, 'sprite.png');
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return [{ path: filePath, mime: 'image/png', source: 'https://x/img.png' }];
    },
    downloadLastAssistantFiles: async ({ outDir }) => {
      const filePath = path.join(outDir, 'spec.txt');
      await fs.writeFile(filePath, 'spec\n', 'utf8');
      return [{ path: filePath, name: 'spec.txt', mime: 'text/plain', source: 'https://x/spec.txt' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
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
    stateDir,
    onOpenArtifactsFolder: async ({ folderPath }) => {
      opened = folderPath;
      return true;
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'all' }
  });
  assert.equal(saved.res.status, 200);
  assert.equal(saved.data.artifacts.length, 2);

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 2);

  const openedResp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/open-folder',
    body: {}
  });
  assert.equal(openedResp.res.status, 200);
  assert.equal(typeof opened, 'string');
});

test('http-api: artifacts open-folder ignores blank scoped selectors and opens global root', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-open-root-'));
  let opened = null;
  const controller = {
    runExclusive: async (fn) => await fn()
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
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
    stateDir,
    onOpenArtifactsFolder: async ({ tabId, folderPath }) => {
      opened = { tabId, folderPath };
      return true;
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const openedResp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/open-folder',
    body: { key: '   ', model: '   ' }
  });
  assert.equal(openedResp.res.status, 200);
  assert.equal(openedResp.data.tabId, null);
  assert.equal(opened?.tabId, null);
  assert.equal(opened?.folderPath, path.join(stateDir, 'artifacts'));
});

test('http-api: artifacts save rejects invalid mode', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-mode-'));
  const controller = {
    runExclusive: async (fn) => await fn()
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
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
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'bogus' }
  });
  assert.equal(resp.res.status, 400);
  assert.equal(resp.data.error, 'invalid_artifact_mode');
});

test('http-api: artifacts save routes model hint to the requested vendor tab', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-model-'));
  const seenEnsure = [];
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantImages: async ({ outDir }) => {
      const filePath = path.join(outDir, 'sprite.png');
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return [{ path: filePath, mime: 'image/png', source: 'https://x/img.png' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
    ensureTab: async (args) => {
      seenEnsure.push(args);
      return 't-claude';
    },
    createTab: async () => 't-claude',
    closeTab: async () => true,
    getControllerById: (id) => {
      assert.equal(id, 't-claude');
      return controller;
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
    ],
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { model: 'claude', key: 'compare', mode: 'images' }
  });
  assert.equal(resp.res.status, 200);
  assert.equal(resp.data.tabId, 't-claude');
  assert.equal(seenEnsure.length, 1);
  assert.equal(seenEnsure[0].key, 'compare');
  assert.equal(seenEnsure[0].vendorId, 'claude');
  assert.equal(seenEnsure[0].url, 'https://claude.ai/');
});

test('http-api: artifacts save fails cleanly before partial writes when controller returns bad artifact path', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-bad-path-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantImages: async ({ outDir }) => [
      { path: path.join(outDir, 'sprite.png'), mime: 'image/png', source: 'https://x/img.png' },
      { path: '   ', mime: 'image/png', source: 'https://x/bad.png' }
    ]
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
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
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'images' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts save fails if controller reports a non-existent artifact file', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-missing-file-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantImages: async ({ outDir }) => [
      { path: path.join(outDir, 'missing.png'), mime: 'image/png', source: 'https://x/missing.png' }
    ]
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
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
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'images' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');
  assert.equal(saved.data.data?.reason, 'missing_artifact_file');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts save rejects files outside the tab artifacts directory', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-outside-'));
  const outside = path.join(stateDir, 'outside.txt');
  await fs.writeFile(outside, 'outside\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantFiles: async () => [
      { path: outside, name: 'outside.txt', mime: 'text/plain', source: 'https://x/outside.txt' }
    ]
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
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
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'files' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');
  assert.equal(saved.data.data?.reason, 'artifact_outside_output_dir');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts save rejects symlink escape outside the tab artifacts directory', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-symlink-'));
  const outside = path.join(stateDir, 'outside.txt');
  await fs.writeFile(outside, 'outside\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantFiles: async ({ outDir }) => {
      const linkPath = path.join(outDir, 'outside-link.txt');
      await fs.symlink(outside, linkPath);
      return [{ path: linkPath, name: 'outside-link.txt', mime: 'text/plain', source: 'https://x/outside.txt' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
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
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'files' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');
  assert.equal(saved.data.data?.reason, 'artifact_symlink_not_allowed');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts save rejects mixed candidates atomically when one is a symlink', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-atomic-symlink-'));
  const outside = path.join(stateDir, 'outside.txt');
  await fs.writeFile(outside, 'outside\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantFiles: async ({ outDir }) => {
      const goodPath = path.join(outDir, 'good.txt');
      const linkPath = path.join(outDir, 'outside-link.txt');
      await fs.writeFile(goodPath, 'good\n', 'utf8');
      await fs.symlink(outside, linkPath);
      return [
        { path: goodPath, name: 'good.txt', mime: 'text/plain', source: 'https://x/good.txt' },
        { path: linkPath, name: 'outside-link.txt', mime: 'text/plain', source: 'https://x/outside.txt' }
      ];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
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
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'files' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');
  assert.equal(saved.data.data?.reason, 'artifact_symlink_not_allowed');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts save rejects hard-link escape outside the tab artifacts directory', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-hardlink-'));
  const outside = path.join(stateDir, 'outside.txt');
  await fs.writeFile(outside, 'outside\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantFiles: async ({ outDir }) => {
      const linkPath = path.join(outDir, 'outside-hardlink.txt');
      await fs.link(outside, linkPath);
      return [{ path: linkPath, name: 'outside-hardlink.txt', mime: 'text/plain', source: 'https://x/outside.txt' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
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
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'files' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');
  assert.equal(saved.data.data?.reason, 'artifact_link_count_not_allowed');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts list without tab scope returns global artifacts', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-global-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantFiles: async ({ outDir }) => {
      const filePath = path.join(outDir, 'spec.txt');
      await fs.writeFile(filePath, 'spec\n', 'utf8');
      return [{ path: filePath, name: 'spec.txt', mime: 'text/plain', source: 'https://x/spec.txt' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
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
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'files' }
  });

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.tabId, null);
  assert.equal(listed.data.artifacts.length, 1);
});

test('http-api: watch-folder list/open/scan work', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-'));
  let opened = null;
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onWatchFoldersList: async () => [{ name: 'inbox', path: path.join(stateDir, 'watch-folders', 'inbox') }],
    onOpenWatchFolder: async ({ folderPath }) => {
      opened = folderPath;
      return true;
    },
    onScanWatchFolder: async () => ({ folderPath: path.join(stateDir, 'watch-folders', 'inbox'), ingested: [{ id: 'a1' }] }),
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const listed = await req({ port, token: 'secret', method: 'GET', pth: '/watch-folders/list' });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.folders.length, 1);

  const openedResp = await req({ port, token: 'secret', method: 'POST', pth: '/watch-folders/open', body: {} });
  assert.equal(openedResp.res.status, 200);
  assert.equal(opened, path.join(stateDir, 'watch-folders', 'inbox'));

  const scanned = await req({ port, token: 'secret', method: 'POST', pth: '/watch-folders/scan', body: {} });
  assert.equal(scanned.res.status, 200);
  assert.equal(scanned.data.ingested.length, 1);
});

test('http-api: watch-folder add/delete work', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-crud-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  let added = null;
  let removed = null;
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onWatchFoldersList: async () => [{ name: 'inbox', path: path.join(stateDir, 'watch-folders', 'inbox') }],
    onAddWatchFolder: async ({ name, folderPath }) => {
      added = { name, path: folderPath };
      return { name: name || 'x', path: folderPath, isDefault: false };
    },
    onRemoveWatchFolder: async ({ name }) => {
      removed = name;
      return true;
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const addResp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/add',
    body: { name: 'sprites', path: '/tmp/sprites' }
  });
  assert.equal(addResp.res.status, 200);
  assert.equal(added.name, 'sprites');

  const delResp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/delete',
    body: { name: 'sprites' }
  });
  assert.equal(delResp.res.status, 200);
  assert.equal(removed, 'sprites');
});

test('http-api: watch-folder add rejects filesystem root', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-root-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onAddWatchFolder: async () => {
      throw new Error('watch_folder_cannot_be_filesystem_root');
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/add',
    body: { name: 'root', path: path.parse(process.cwd()).root }
  });
  assert.equal(resp.res.status, 400);
  assert.equal(resp.data.error, 'watch_folder_cannot_be_filesystem_root');
});

test('http-api: watch-folder add rejects file paths cleanly', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-file-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onAddWatchFolder: async () => {
      throw new Error('watch_folder_not_directory');
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/add',
    body: { name: 'filey', path: '/tmp/not-a-dir.txt' }
  });
  assert.equal(resp.res.status, 400);
  assert.equal(resp.data.error, 'watch_folder_not_directory');
});

test('http-api: watch-folders/add rejects relative paths on the direct HTTP surface', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-relative-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onAddWatchFolder: async () => {
      throw new Error('should_not_be_called');
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/add',
    body: { name: 'sprites', path: './sprites' }
  });
  assert.equal(resp.res.status, 400);
  assert.equal(resp.data.error, 'relative_path_not_allowed');
  assert.equal(resp.data.data?.field, 'path');
});

test('http-api: opening unknown watch folder returns 404', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-missing-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onWatchFoldersList: async () => [{ name: 'inbox', path: path.join(stateDir, 'watch-folders', 'inbox') }],
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/open',
    body: { name: 'missing' }
  });
  assert.equal(resp.res.status, 404);
  assert.equal(resp.data.error, 'watch_folder_not_found');
});

test('http-api: query returns vendor-specific context budget', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-budget-'));
  await fs.writeFile(path.join(dir, 'repo.txt'), 'hello from repo\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'claude' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'Summarize this project.', contextPaths: [dir] }
  });

  assert.equal(r.res.status, 200);
  assert.equal(r.data.packedContextBudget.maxContextChars, 140000);
});

test('http-api: query returns effective override context budget metadata', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-budget-override-'));
  await fs.writeFile(path.join(dir, 'repo.txt'), 'hello from repo\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'claude' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: {
      prompt: 'Summarize this project.',
      contextPaths: [dir],
      maxContextChars: 1234,
      maxContextChunkChars: 222,
      maxContextChunksPerFile: 3,
      maxContextInlineFiles: 4,
      maxContextAttachments: 5
    }
  });

  assert.equal(r.res.status, 200);
  assert.equal(r.data.packedContextBudget.maxContextChars, 1234);
  assert.equal(r.data.packedContextBudget.maxChunkChars, 222);
  assert.equal(r.data.packedContextBudget.maxChunksPerFile, 3);
  assert.equal(r.data.packedContextBudget.maxInlineFiles, 4);
  assert.equal(r.data.packedContextBudget.maxAttachmentFiles, 5);
});

test('http-api: query ignores invalid non-positive context budget overrides', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-budget-invalid-'));
  await fs.writeFile(path.join(dir, 'repo.txt'), 'hello from repo\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'claude' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: {
      prompt: 'Summarize this project.',
      contextPaths: [dir],
      maxContextChars: -123,
      maxContextChunkChars: 0,
      maxContextChunksPerFile: -2,
      maxContextInlineFiles: 'nope',
      maxContextAttachments: -5
    }
  });

  assert.equal(r.res.status, 200);
  assert.equal(r.data.packedContextBudget.maxContextChars, 140000);
  assert.equal(r.data.packedContextBudget.maxChunkChars, 7500);
  assert.equal(r.data.packedContextBudget.maxChunksPerFile, 3);
  assert.equal(r.data.packedContextBudget.maxInlineFiles, 20);
  assert.equal(r.data.packedContextBudget.maxAttachmentFiles, 12);
});

test('http-api: non-positive timeoutMs values fall back to safe defaults', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-timeout-clamp-'));
  const seen = { ensureReady: [], query: [], send: [] };
  const controller = {
    runExclusive: async (fn) => await fn(),
    ensureReady: async ({ timeoutMs }) => {
      seen.ensureReady.push(timeoutMs);
      return { ok: true };
    },
    query: async ({ timeoutMs }) => {
      seen.query.push(timeoutMs);
      return { text: 'ok', codeBlocks: [], meta: {} };
    },
    send: async ({ timeoutMs }) => {
      seen.send.push(timeoutMs);
      return { ok: true };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const ready = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/ensure-ready',
    body: { timeoutMs: -1 }
  });
  assert.equal(ready.res.status, 200);

  const queried = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'hi', timeoutMs: 0 }
  });
  assert.equal(queried.res.status, 200);

  const sent = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/send',
    body: { text: 'hi', timeoutMs: -50 }
  });
  assert.equal(sent.res.status, 200);

  assert.deepEqual(seen.ensureReady, [10 * 60_000]);
  assert.deepEqual(seen.query, [10 * 60_000]);
  assert.deepEqual(seen.send, [3 * 60_000]);
});

test('http-api: oversized numeric overrides are clamped to bounded ceilings', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-ceiling-clamp-'));
  await fs.writeFile(path.join(dir, 'repo.txt'), 'hello from repo\n', 'utf8');
  const seen = { query: [], read: [], images: [], files: [] };
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async ({ timeoutMs }) => {
      seen.query.push(timeoutMs);
      return { text: 'ok', codeBlocks: [], meta: {} };
    },
    readPageText: async ({ maxChars }) => {
      seen.read.push(maxChars);
      return 'ok';
    },
    downloadLastAssistantImages: async ({ maxImages, outDir }) => {
      seen.images.push(maxImages);
      const filePath = path.join(outDir, 'sprite.png');
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return [{ path: filePath, mime: 'image/png', source: 'https://x/img.png' }];
    },
    downloadLastAssistantFiles: async ({ maxFiles, outDir }) => {
      seen.files.push(maxFiles);
      const filePath = path.join(outDir, 'spec.txt');
      await fs.writeFile(filePath, 'spec\n', 'utf8');
      return [{ path: filePath, name: 'spec.txt', mime: 'text/plain', source: 'https://x/spec.txt' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'claude' }],
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
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const queried = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: {
      prompt: 'Summarize this project.',
      contextPaths: [dir],
      timeoutMs: 999_999_999,
      maxContextChars: 9_999_999,
      maxContextFiles: 9_999,
      maxContextFileChars: 9_999_999,
      maxContextChunkChars: 9_999_999,
      maxContextChunksPerFile: 9_999,
      maxContextInlineFiles: 9_999,
      maxContextAttachments: 9_999
    }
  });
  assert.equal(queried.res.status, 200);
  assert.equal(seen.query[0], 30 * 60_000);
  assert.equal(queried.data.packedContextBudget.maxContextChars, 500_000);
  assert.equal(queried.data.packedContextBudget.maxFiles, 500);
  assert.equal(queried.data.packedContextBudget.maxFileChars, 100_000);
  assert.equal(queried.data.packedContextBudget.maxChunkChars, 20_000);
  assert.equal(queried.data.packedContextBudget.maxChunksPerFile, 20);
  assert.equal(queried.data.packedContextBudget.maxInlineFiles, 100);
  assert.equal(queried.data.packedContextBudget.maxAttachmentFiles, 50);

  const read = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/read-page',
    body: { maxChars: 9_999_999 }
  });
  assert.equal(read.res.status, 200);
  assert.equal(seen.read[0], 1_000_000);

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'all', maxImages: 9_999, maxFiles: 9_999 }
  });
  assert.equal(saved.res.status, 200);
  assert.equal(seen.images[0], 50);
  assert.equal(seen.files[0], 50);
});

test('http-api: query model hint routes to a vendor-scoped tab when default tab is another vendor', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-model-route-'));
  const seenEnsure = [];
  const seenQuery = [];
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async (args) => {
      seenQuery.push(args);
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
    ensureTab: async (args) => {
      seenEnsure.push(args);
      return 't-claude';
    },
    createTab: async () => 't-claude',
    closeTab: async () => true,
    getControllerById: (id) => {
      assert.equal(id, 't-claude');
      return controller;
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
    ],
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { model: 'claude', prompt: 'hi' }
  });

  assert.equal(r.res.status, 200);
  assert.equal(seenEnsure.length, 1);
  assert.equal(seenEnsure[0].key, 'vendor:claude');
  assert.equal(seenEnsure[0].vendorId, 'claude');
  assert.equal(seenEnsure[0].url, 'https://claude.ai/');
  assert.equal(seenQuery.length, 1);
  assert.equal(r.data.tabId, 't-claude');
});

test('http-api: query rejects unknown vendor hint', async (t) => {
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
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
    vendors: [{ id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' }],
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { model: 'unknown-vendor', prompt: 'hi' }
  });

  assert.equal(r.res.status, 400);
  assert.equal(r.data.error, 'invalid_vendor');
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

  const controllers = new Map();
  const getController = (id) => {
    if (!controllers.has(id)) {
      controllers.set(id, {
        runExclusive: async (fn) => await fn(),
        query: async () => {
          started += 1;
          await gate;
          return { text: 'ok' };
        }
      });
    }
    return controllers.get(id);
  };

  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default' }, { id: 't1', key: 'q1' }, { id: 't2', key: 'q2' }],
    ensureTab: async ({ key }) => {
      if (key === 'q1') return 't1';
      if (key === 'q2') return 't2';
      return 't0';
    },
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: (id) => getController(id)
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

  const q1 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'q1', prompt: 'hi' } });
  // Give the server a moment to enter the handler and increment inflight.
  for (let i = 0; i < 50 && started === 0; i++) await new Promise((r) => setTimeout(r, 5));

  const q2 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'q2', prompt: 'hi2' } });
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
    listTabs: () => [{ id: 't0', key: 'default' }, { id: 't1', key: 'q1' }, { id: 't2', key: 'q2' }],
    ensureTab: async ({ key }) => {
      if (key === 'q1') return 't1';
      if (key === 'q2') return 't2';
      return 't0';
    },
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

  const p1 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'q1', prompt: 'a', attachments: [] } });
  // Let the first request enter inflight.
  await new Promise((r) => setTimeout(r, 20));
  const p2 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'q2', prompt: 'b', attachments: [] } });

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
