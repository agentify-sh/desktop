import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { readState, readToken } from './state.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function electronLaunch({ platform, allowFallback = false }) {
  const override = String(process.env.AGENTIFY_DESKTOP_ELECTRON_BIN || '').trim();
  if (override) {
    return {
      command: override,
      argsPrefix: [],
      shell: platform === 'win32' && /\.(cmd|bat)$/i.test(override)
    };
  }

  const electronCli = path.resolve(__dirname, 'node_modules', 'electron', 'cli.js');
  if (await fileExists(electronCli)) {
    return { command: process.execPath, argsPrefix: [electronCli], shell: false };
  }

  if (allowFallback) {
    return { command: 'electron', argsPrefix: [], shell: platform === 'win32' };
  }

  throw new Error('missing_electron_binary');
}

export async function loadConnection({ stateDir }) {
  const state = await readState(stateDir);
  const token = await readToken(stateDir);
  if (!state?.port || !token) return null;
  return { baseUrl: `http://127.0.0.1:${state.port}`, token, serverId: state.serverId || null };
}

async function validateConn({ conn, fetchImpl }) {
  // 1) Health: ensures something is listening, and optionally matches serverId.
  const health = await fetchImpl(`${conn.baseUrl}/health`);
  const healthData = await health.json().catch(() => ({}));
  if (!health.ok) return { ok: false, reason: 'health_not_ok' };
  if (conn.serverId && healthData?.serverId && conn.serverId !== healthData.serverId) return { ok: false, reason: 'server_id_mismatch' };

  // 2) Authenticated status: only AUTH failures invalidate a live server —
  // /status can carry tab-level errors (e.g. tab_not_found before any default
  // tab exists) while the server is healthy and ours.
  const status = await fetchImpl(`${conn.baseUrl}/status`, { headers: { authorization: `Bearer ${conn.token}` } });
  if (status.status === 401 || status.status === 403) return { ok: false, reason: 'unauthorized' };
  const statusData = await status.json().catch(() => ({}));
  if (statusData?.error === 'unauthorized') return { ok: false, reason: 'unauthorized' };
  return { ok: true, serverId: healthData?.serverId || null };
}

// Default transport is node:http, NOT fetch: Node's built-in fetch (undici)
// enforces a ~5-minute headers timeout, which kills long-blocking calls like
// /query while a reasoning model thinks for up to an hour. Passing a custom
// fetchImpl (tests) keeps the fetch-shaped path.
export async function requestJson({ baseUrl, token, method, path: pth, body, fetchImpl = null, timeoutMs = 0 }) {
  if (fetchImpl) {
    const res = await fetchImpl(`${baseUrl}${pth}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      const err = new Error(data?.message || data?.error || `http_${res.status}`);
      err.data = { status: res.status, body: data };
      throw err;
    }
    return data;
  }

  const { request } = await import('node:http');
  return await new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const u = new URL(baseUrl + pth);
    const req = request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && !parsed?.error) return resolve(parsed);
        const err = new Error(parsed?.message || parsed?.error || `http_${res.statusCode}`);
        err.data = { status: res.statusCode, body: parsed };
        reject(err);
      });
    });
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`client_timeout_${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function ensureDesktopRunning({
  stateDir,
  fetchImpl = fetch,
  spawnImpl = spawn,
  timeoutMs = 30_000,
  showTabs = false,
  platform = process.platform
}) {
  const conn = await loadConnection({ stateDir });
  if (conn) {
    try {
      const v = await validateConn({ conn, fetchImpl });
      if (v.ok) return conn;
    } catch {
      // fallthrough to spawn
    }
  }

  const entry = path.join(__dirname, 'main.mjs');
  const launch = await electronLaunch({ platform, allowFallback: spawnImpl !== spawn });
  if (!(await fileExists(entry))) throw new Error('missing_desktop_entry');

  spawnImpl(launch.command, [...launch.argsPrefix, entry], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AGENTIFY_DESKTOP_STATE_DIR: stateDir,
      ...(showTabs ? { AGENTIFY_DESKTOP_SHOW_TABS: 'true' } : {})
    },
    shell: launch.shell
  })?.unref?.();

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = await loadConnection({ stateDir });
    if (c) {
      try {
        const v = await validateConn({ conn: c, fetchImpl });
        if (v.ok) return c;
      } catch {}
    }
    await sleep(300);
  }
  throw new Error('desktop_start_timeout');
}
