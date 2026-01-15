import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

async function atomicWriteJson(filePath, obj, { mode } = {}) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const data = `${JSON.stringify(obj, null, 2)}\n`;
  await fs.writeFile(tmp, data, mode ? { encoding: 'utf8', mode } : { encoding: 'utf8' });
  await fs.rename(tmp, filePath);
}

export function orchestratorDir(stateDir) {
  return path.join(stateDir, 'orchestrator');
}

export function handledPath(stateDir) {
  return path.join(orchestratorDir(stateDir), 'handled.json');
}

export function sessionsPath(stateDir) {
  return path.join(orchestratorDir(stateDir), 'sessions.json');
}

export function workspaceConfigPath(stateDir) {
  return path.join(orchestratorDir(stateDir), 'workspaces.json');
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, obj, opts) {
  await atomicWriteJson(filePath, obj, opts);
}

export async function loadHandled(stateDir) {
  const p = handledPath(stateDir);
  const data = await readJson(p, { keys: {} });
  if (!data || typeof data !== 'object') return { keys: {} };
  if (!data.keys || typeof data.keys !== 'object') data.keys = {};
  return data;
}

export async function markHandled(stateDir, { key, id, status, meta = null }) {
  const data = await loadHandled(stateDir);
  const k = String(key || '').trim();
  const i = String(id || '').trim();
  if (!k || !i) throw new Error('missing_key_or_id');
  if (!data.keys[k]) data.keys[k] = {};
  data.keys[k][i] = { status: status || 'done', meta, at: new Date().toISOString() };
  await writeJson(handledPath(stateDir), data, { mode: 0o600 });
  return data.keys[k][i];
}

export async function isHandled(stateDir, { key, id }) {
  const data = await loadHandled(stateDir);
  return !!data?.keys?.[String(key)]?.[String(id)];
}

export async function loadSessions(stateDir) {
  const data = await readJson(sessionsPath(stateDir), { keys: {} });
  if (!data || typeof data !== 'object') return { keys: {} };
  if (!data.keys || typeof data.keys !== 'object') data.keys = {};
  return data;
}

export async function setSession(stateDir, { key, session }) {
  const data = await loadSessions(stateDir);
  const k = String(key || '').trim();
  if (!k) throw new Error('missing_key');
  data.keys[k] = session || null;
  await writeJson(sessionsPath(stateDir), data, { mode: 0o600 });
  return data.keys[k];
}

export async function getSession(stateDir, { key }) {
  const data = await loadSessions(stateDir);
  return data?.keys?.[String(key)] || null;
}

export async function loadWorkspaces(stateDir) {
  const data = await readJson(workspaceConfigPath(stateDir), { keys: {} });
  if (!data || typeof data !== 'object') return { keys: {} };
  if (!data.keys || typeof data.keys !== 'object') data.keys = {};
  return data;
}

function normalizeWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;
  const root = String(workspace.root || '').trim();
  if (!root) return null;
  const allowRootsRaw = Array.isArray(workspace.allowRoots) ? workspace.allowRoots : [root];
  const allowRoots = Array.from(new Set(allowRootsRaw.map((r) => String(r || '').trim()).filter(Boolean)));
  return {
    root,
    allowRoots: allowRoots.length ? allowRoots : [root],
    configuredAt: typeof workspace.configuredAt === 'string' && workspace.configuredAt.trim() ? workspace.configuredAt.trim() : new Date().toISOString()
  };
}

export async function setWorkspace(stateDir, { key, workspace }) {
  const data = await loadWorkspaces(stateDir);
  const k = String(key || '').trim();
  if (!k) throw new Error('missing_key');
  data.keys[k] = normalizeWorkspace(workspace);
  await writeJson(workspaceConfigPath(stateDir), data, { mode: 0o600 });
  return data.keys[k];
}

export async function getWorkspace(stateDir, { key }) {
  const data = await loadWorkspaces(stateDir);
  return normalizeWorkspace(data?.keys?.[String(key)] || null);
}
