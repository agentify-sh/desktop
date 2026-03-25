import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function cleanSegment(value, fallback = 'default') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return fallback;
  const safe = trimmed.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return safe || fallback;
}

async function appendLine(filePath, line) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${line}\n`, 'utf8');
}

export function artifactsRoot(stateDir) {
  return path.join(stateDir, 'artifacts');
}

export function artifactsIndexPath(stateDir) {
  return path.join(artifactsRoot(stateDir), 'index.jsonl');
}

export function tabArtifactsDir({ stateDir, tabId, tabKey = null, vendorId = null } = {}) {
  const prefix = cleanSegment(tabKey || vendorId || 'tab');
  const suffix = cleanSegment(String(tabId || '').slice(0, 12), crypto.randomUUID().slice(0, 12));
  return path.join(artifactsRoot(stateDir), `${prefix}-${suffix}`);
}

export async function ensureArtifactsDir({ stateDir, tabId, tabKey = null, vendorId = null } = {}) {
  const dir = tabArtifactsDir({ stateDir, tabId, tabKey, vendorId });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function registerArtifact({
  stateDir,
  tabId,
  tabKey = null,
  vendorId = null,
  kind = 'file',
  filePath,
  originalName = null,
  mime = null,
  source = null,
  meta = null
} = {}) {
  const rawPath = String(filePath || '').trim();
  if (!rawPath) throw new Error('missing_artifact_path');
  if (!path.isAbsolute(rawPath)) throw new Error('relative_artifact_path_not_allowed');
  let st = null;
  try {
    st = await fs.lstat(rawPath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw new Error('missing_artifact_file');
    throw error;
  }
  if (st.isSymbolicLink()) throw new Error('artifact_symlink_not_allowed');
  if (!st.isFile()) throw new Error('artifact_path_not_file');
  if (Number(st.nlink || 1) > 1) throw new Error('artifact_link_count_not_allowed');
  const savedAt = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    tabId: String(tabId || '').trim() || null,
    tabKey: String(tabKey || '').trim() || null,
    vendorId: String(vendorId || '').trim() || null,
    kind: String(kind || 'file').trim() || 'file',
    path: path.resolve(rawPath),
    name: String(originalName || path.basename(rawPath)).trim() || path.basename(rawPath),
    mime: mime ? String(mime) : null,
    source: source ? String(source) : null,
    meta: meta && typeof meta === 'object' ? meta : null,
    savedAt
  };
  await appendLine(artifactsIndexPath(stateDir), JSON.stringify(record));
  return record;
}

export async function listArtifacts({ stateDir, tabId = null, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  let raw = '';
  try {
    raw = await fs.readFile(artifactsIndexPath(stateDir), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
    try {
      const item = JSON.parse(lines[i]);
      const itemPath = String(item?.path || '').trim();
      if (!path.isAbsolute(itemPath)) continue;
      let st = null;
      try {
        st = await fs.lstat(itemPath);
      } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
        throw error;
      }
      if (st.isSymbolicLink()) continue;
      if (!st.isFile()) continue;
      if (Number(st.nlink || 1) > 1) continue;
      if (tabId && String(item?.tabId || '') !== String(tabId || '')) continue;
      out.push(item);
    } catch {}
  }
  return out;
}
