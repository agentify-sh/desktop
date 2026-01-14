import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { ensureToken, writeState } from '../state.mjs';
import { ensureDesktopRunning, requestJson } from '../mcp-lib.mjs';

async function tempDir() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  return base;
}

function makeFetch({ getServerId, acceptToken = 't' }) {
  return async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, serverId: getServerId() };
        }
      };
    }
    if (u.endsWith('/status')) {
      const hdr = String(opts?.headers?.authorization || '');
      const okAuth = hdr === `Bearer ${acceptToken}`;
      return {
        ok: okAuth,
        status: okAuth ? 200 : 401,
        async json() {
          return okAuth ? { ok: true, url: 'https://chatgpt.com/', tabs: [] } : { error: 'unauthorized' };
        }
      };
    }
    throw new Error(`unexpected_url:${url}`);
  };
}

test('mcp-lib: requestJson throws with status and body', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    async json() {
      return { error: 'forbidden', message: 'nope' };
    }
  });

  await assert.rejects(
    () => requestJson({ baseUrl: 'http://x', token: 't', method: 'GET', path: '/status', fetchImpl }),
    (err) => {
      assert.equal(err.message, 'nope');
      assert.equal(err.data.status, 403);
      assert.equal(err.data.body.error, 'forbidden');
      return true;
    }
  );
});

test('mcp-lib: ensureDesktopRunning uses existing connection when serverId matches', async () => {
  const dir = await tempDir();
  await ensureToken(dir);
  await writeState({ ok: true, port: 12345, serverId: 'sid-a' }, dir);

  const token = 't';
  await fs.writeFile(path.join(dir, 'token.txt'), `${token}\n`, 'utf8');

  const conn = await ensureDesktopRunning({
    stateDir: dir,
    fetchImpl: makeFetch({ getServerId: () => 'sid-a', acceptToken: token }),
    spawnImpl: () => {
      throw new Error('should_not_spawn');
    },
    timeoutMs: 1000
  });
  assert.equal(conn.serverId, 'sid-a');
});

test('mcp-lib: ensureDesktopRunning spawns if serverId mismatches and then recovers', async () => {
  const dir = await tempDir();
  const token = 't';
  await ensureToken(dir);
  await fs.writeFile(path.join(dir, 'token.txt'), `${token}\n`, 'utf8');
  await writeState({ ok: true, port: 12345, serverId: 'sid-old' }, dir);

  let fetchServerId = 'sid-wrong';
  const fetchImpl = makeFetch({ getServerId: () => fetchServerId, acceptToken: token });

  let spawned = 0;
  const spawnImpl = (_cmd, _args, opts) => {
    spawned += 1;
    assert.equal(opts?.env?.AGENTIFY_DESKTOP_SHOW_TABS, 'true');
    // Simulate that the spawned app writes a new state with matching serverId.
    fetchServerId = 'sid-new';
    void writeState({ ok: true, port: 12345, serverId: 'sid-new' }, dir);
    return { unref() {} };
  };

  const conn = await ensureDesktopRunning({ stateDir: dir, fetchImpl, spawnImpl, timeoutMs: 3000, showTabs: true });
  assert.ok(spawned >= 1);
  assert.equal(conn.serverId, 'sid-new');
});
