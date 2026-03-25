import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function normalizePathList(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    if (!path.isAbsolute(trimmed)) continue;
    const v = path.resolve(trimmed);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function normalizeName(name) {
  const v = String(name || '').trim();
  if (!v) throw new Error('missing_bundle_name');
  if (v.length > 120) throw new Error('bundle_name_too_large');
  return v;
}

function bundlesPath(stateDir) {
  return path.join(stateDir, 'bundles.json');
}

async function atomicWriteFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function normalizeBundle(input = {}) {
  const now = new Date().toISOString();
  return {
    name: normalizeName(input.name),
    promptPrefix: String(input.promptPrefix || '').trim(),
    attachments: normalizePathList(input.attachments),
    contextPaths: normalizePathList(input.contextPaths),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now
  };
}

async function readAll(stateDir) {
  try {
    const raw = JSON.parse(await fs.readFile(bundlesPath(stateDir), 'utf8'));
    const list = Array.isArray(raw?.bundles) ? raw.bundles : [];
    return list.map((item) => normalizeBundle(item));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

async function writeAll(stateDir, bundles) {
  const cleaned = bundles
    .map((item) => normalizeBundle(item))
    .sort((a, b) => a.name.localeCompare(b.name));
  await atomicWriteFile(bundlesPath(stateDir), `${JSON.stringify({ bundles: cleaned }, null, 2)}\n`);
  return cleaned;
}

export async function listBundles(stateDir) {
  return await readAll(stateDir);
}

export async function getBundle(stateDir, name) {
  const target = normalizeName(name);
  const all = await readAll(stateDir);
  return all.find((item) => item.name === target) || null;
}

export async function saveBundle(stateDir, input) {
  const next = normalizeBundle(input);
  next.updatedAt = new Date().toISOString();
  const all = await readAll(stateDir);
  const idx = all.findIndex((item) => item.name === next.name);
  if (idx >= 0) {
    next.createdAt = all[idx].createdAt || next.createdAt;
    all[idx] = next;
  } else {
    all.push(next);
  }
  await writeAll(stateDir, all);
  return next;
}

export async function deleteBundle(stateDir, name) {
  const target = normalizeName(name);
  const all = await readAll(stateDir);
  const next = all.filter((item) => item.name !== target);
  const found = next.length !== all.length;
  if (found) await writeAll(stateDir, next);
  return found;
}
