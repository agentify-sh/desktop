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

  // 2) Authenticated status: ensures token matches and the server is ours.
  const status = await fetchImpl(`${conn.baseUrl}/status`, { headers: { authorization: `Bearer ${conn.token}` } });
  const statusData = await status.json().catch(() => ({}));
  if (!status.ok) return { ok: false, reason: 'status_not_ok', status: status.status };
  if (statusData?.error === 'unauthorized') return { ok: false, reason: 'unauthorized' };
  if (statusData?.ok !== true) return { ok: false, reason: 'unexpected_status_payload' };
  return { ok: true, serverId: healthData?.serverId || null };
}

export async function requestJson({ baseUrl, token, method, path: pth, body, fetchImpl = fetch }) {
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

export async function ensureDesktopRunning({
  stateDir,
  fetchImpl = fetch,
  spawnImpl = spawn,
  timeoutMs = 30_000,
  showTabsByDefault = false
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

  const electronBin = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const entry = path.join(__dirname, 'main.mjs');
  if (!(await fileExists(electronBin))) throw new Error('missing_electron_binary');
  if (!(await fileExists(entry))) throw new Error('missing_desktop_entry');

  spawnImpl(electronBin, [entry], {
    stdio: 'ignore',
    env: {
      ...process.env,
      AGENTIFY_DESKTOP_STATE_DIR: stateDir,
      ...(showTabsByDefault ? { AGENTIFY_DESKTOP_SHOW_TABS_BY_DEFAULT: '1' } : {})
    }
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
