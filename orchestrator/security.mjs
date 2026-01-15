import path from 'node:path';

export function normalizeAbs(p) {
  return path.resolve(String(p || '').trim());
}

export function isPathWithin({ filePath, allowedRoots }) {
  const fp = normalizeAbs(filePath);
  const roots = Array.isArray(allowedRoots) ? allowedRoots.map(normalizeAbs) : [];
  if (!roots.length) return false;
  for (const r of roots) {
    const rel = path.relative(r, fp);
    if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..')) return true;
  }
  return false;
}

export function assertWithin({ filePath, allowedRoots }) {
  if (!isPathWithin({ filePath, allowedRoots })) {
    const err = new Error('path_not_allowed');
    err.data = { filePath: String(filePath || ''), allowedRoots: (allowedRoots || []).map(String) };
    throw err;
  }
}

