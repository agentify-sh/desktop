import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { registerArtifact } from './artifact-store.mjs';

function watchRoot(stateDir) {
  return path.join(stateDir, 'watch-folders');
}

export function defaultWatchFolder(stateDir) {
  return path.join(watchRoot(stateDir), 'inbox');
}

function watchStatePath(stateDir) {
  return path.join(watchRoot(stateDir), 'state.json');
}

async function atomicWriteFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function cleanFolderName(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function defaultFolders(stateDir) {
  return [{ name: 'inbox', path: defaultWatchFolder(stateDir), isDefault: true }];
}

function normalizeAbsoluteFolderPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!path.isAbsolute(raw)) return '';
  return path.resolve(raw);
}

function normalizeFolders(stateDir, rawFolders) {
  const out = [];
  const names = new Set();
  const paths = new Set();

  const pushFolder = (item, { fallbackName = 'folder', isDefault = false } = {}) => {
    const absPath = normalizeAbsoluteFolderPath(item?.path);
    if (!absPath) return;
    if (paths.has(absPath)) return;

    let name = cleanFolderName(item?.name || '');
    if (!name) name = cleanFolderName(path.basename(absPath)) || fallbackName;
    let unique = name;
    let suffix = 2;
    while (names.has(unique)) {
      unique = `${name}-${suffix}`;
      suffix += 1;
    }

    names.add(unique);
    paths.add(absPath);
    out.push({ name: unique, path: absPath, isDefault: !!isDefault });
  };

  for (const item of defaultFolders(stateDir)) pushFolder(item, { fallbackName: 'inbox', isDefault: true });
  if (Array.isArray(rawFolders)) {
    for (const item of rawFolders) pushFolder(item, { fallbackName: 'folder', isDefault: false });
  }

  return out.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function canonicalizeFolders(stateDir, rawFolders) {
  const normalized = normalizeFolders(stateDir, rawFolders);
  const out = [];
  const names = new Set();
  const paths = new Set();

  for (const item of normalized) {
    try {
      const st = await fs.stat(item.path);
      if (!st.isDirectory()) continue;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        await fs.mkdir(item.path, { recursive: true });
      } else {
        throw error;
      }
    }
    const realPath = await fs.realpath(item.path);
    if (paths.has(realPath)) continue;

    let name = cleanFolderName(item.name || '');
    if (!name) name = cleanFolderName(path.basename(item.path)) || 'folder';
    let unique = name;
    let suffix = 2;
    while (names.has(unique)) {
      unique = `${name}-${suffix}`;
      suffix += 1;
    }

    names.add(unique);
    paths.add(realPath);
    out.push({ name: unique, path: realPath, isDefault: !!item.isDefault });
  }

  return out.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function readState(stateDir) {
  try {
    const raw = JSON.parse(await fs.readFile(watchStatePath(stateDir), 'utf8'));
    return raw && typeof raw === 'object' ? raw : { folders: [], files: {} };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { folders: [], files: {} };
    if (error instanceof SyntaxError) return { folders: [], files: {} };
    throw error;
  }
}

async function writeState(stateDir, state) {
  await atomicWriteFile(watchStatePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}

function shouldSkipName(name) {
  const v = String(name || '');
  return !v || v.startsWith('.') || v.endsWith('.tmp') || v.endsWith('.crdownload') || v.endsWith('.part');
}

async function walkFiles(rootDir, absDir, out) {
  let entries = [];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM')) return;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (shouldSkipName(entry.name)) continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(rootDir, abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    let st = null;
    try {
      st = await fs.stat(abs);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM')) continue;
      throw error;
    }
    const rel = path.relative(rootDir, abs) || entry.name;
    out.push({ absPath: abs, relPath: rel, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
  }
}

function fileFingerprint(item) {
  return `${Number(item.mtimeMs || 0)}:${Number(item.size || 0)}`;
}

function isSkippableArtifactError(error) {
  const msg = String(error?.message || '');
  return (
    msg === 'missing_artifact_file' ||
    msg === 'artifact_path_not_file' ||
    msg === 'artifact_symlink_not_allowed' ||
    msg === 'artifact_link_count_not_allowed'
  );
}

export function createWatchFolderManager({ stateDir, pollMs = 1500, onIngested = null } = {}) {
  let timer = null;
  let scanning = false;
  let currentState = { folders: [], files: {} };

  async function ensureReady() {
    await fs.mkdir(watchRoot(stateDir), { recursive: true });
    currentState = await readState(stateDir);
    if (!currentState || typeof currentState !== 'object') currentState = { folders: [], files: {} };
    currentState.files = currentState.files && typeof currentState.files === 'object' ? currentState.files : {};
    currentState.folders = await canonicalizeFolders(stateDir, currentState.folders);
    await writeState(stateDir, currentState);
  }

  async function listFolders() {
    await ensureReady();
    return currentState.folders.map((item) => ({ ...item }));
  }

  async function getFolderByName(name) {
    await ensureReady();
    const target = cleanFolderName(name);
    if (!target) return currentState.folders[0] || null;
    return currentState.folders.find((item) => item.name === target) || null;
  }

  async function addFolder({ name, folderPath } = {}) {
    await ensureReady();
    const absPath = normalizeAbsoluteFolderPath(folderPath);
    if (!absPath) throw new Error('missing_watch_folder_path');
    if (absPath === path.parse(absPath).root) throw new Error('watch_folder_cannot_be_filesystem_root');
    try {
      const st = await fs.stat(absPath);
      if (!st.isDirectory()) throw new Error('watch_folder_not_directory');
    } catch (error) {
      if (String(error?.message || '') === 'watch_folder_not_directory') throw error;
      if (error && error.code === 'ENOENT') {
        await fs.mkdir(absPath, { recursive: true });
      } else {
        throw error;
      }
    }
    const realAbsPath = await fs.realpath(absPath);
    for (const folder of currentState.folders) {
      if (folder.path === realAbsPath) return folder;
      if (realAbsPath.startsWith(`${folder.path}${path.sep}`) || folder.path.startsWith(`${realAbsPath}${path.sep}`)) {
        throw new Error('watch_folder_overlaps_existing');
      }
    }
    const rawFolders = [...currentState.folders, { name, path: realAbsPath, isDefault: false }];
    currentState.folders = await canonicalizeFolders(stateDir, rawFolders);
    await writeState(stateDir, currentState);
    return currentState.folders.find((item) => item.path === realAbsPath) || null;
  }

  async function removeFolder({ name } = {}) {
    await ensureReady();
    const target = cleanFolderName(name);
    if (!target) throw new Error('missing_watch_folder_name');
    const before = currentState.folders.length;
    currentState.folders = currentState.folders.filter((item) => !(item.name === target && !item.isDefault));
    const deleted = currentState.folders.length !== before;
    if (deleted) {
      const allowedRoots = new Set(currentState.folders.map((item) => item.path));
      currentState.files = Object.fromEntries(
        Object.entries(currentState.files).filter(([absPath]) => {
          for (const root of allowedRoots) {
            if (absPath === root || absPath.startsWith(`${root}${path.sep}`)) return true;
          }
          return false;
        })
      );
      await writeState(stateDir, currentState);
    }
    return deleted;
  }

  async function scan() {
    if (scanning) return { ingested: [], folders: await listFolders() };
    scanning = true;
    try {
      await ensureReady();
      const discovered = [];
      for (const folder of currentState.folders) {
        await walkFiles(folder.path, folder.path, discovered);
      }

      const nextFiles = {};
      const ingested = [];
      for (const folder of currentState.folders) {
        const rootPrefix = `${folder.path}${path.sep}`;
        for (const item of discovered.filter((entry) => entry.absPath === folder.path || entry.absPath.startsWith(rootPrefix))) {
          const fingerprint = fileFingerprint(item);
          nextFiles[item.absPath] = fingerprint;
          if (currentState.files[item.absPath] === fingerprint) continue;
          try {
            const artifact = await registerArtifact({
              stateDir,
              tabId: null,
              tabKey: `watch-${folder.name}`,
              vendorId: null,
              kind: 'watch-file',
              filePath: item.absPath,
              originalName: `${folder.name}/${item.relPath}`,
              mime: null,
              source: null,
              meta: { watchFolder: true, watchFolderName: folder.name, relPath: item.relPath, size: item.size }
            });
            ingested.push(artifact);
          } catch (error) {
            if (!isSkippableArtifactError(error)) throw error;
          }
        }
      }

      currentState.files = nextFiles;
      await writeState(stateDir, currentState);

      if (ingested.length && typeof onIngested === 'function') {
        await onIngested({ folders: currentState.folders.map((item) => ({ ...item })), artifacts: ingested });
      }

      return { ingested, folders: currentState.folders.map((item) => ({ ...item })) };
    } finally {
      scanning = false;
    }
  }

  async function start() {
    await ensureReady();
    await scan();
    if (!timer) {
      timer = setInterval(() => {
        scan().catch(() => {});
      }, Math.max(500, Number(pollMs) || 1500));
      timer.unref?.();
    }
    return { ok: true, folders: await listFolders() };
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    scan,
    listFolders,
    getFolderByName,
    addFolder,
    removeFolder,
    getInboxPath: () => defaultWatchFolder(stateDir)
  };
}
