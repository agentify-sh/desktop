import fs from 'node:fs/promises';
import path from 'node:path';

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'out'
]);

const BINARY_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.bz2',
  '.7z',
  '.mp3',
  '.mp4',
  '.mov',
  '.wav',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.exe',
  '.dylib',
  '.so',
  '.dll',
  '.bin'
]);

function extnameLower(filePath) {
  return path.extname(String(filePath || '')).toLowerCase();
}

function normalizeAbsoluteInputPath(value, { cwd = process.cwd() } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

function looksBinaryByName(filePath) {
  return BINARY_EXTS.has(extnameLower(filePath));
}

function codeFenceLang(filePath) {
  const ext = extnameLower(filePath);
  return (
    {
      '.js': 'js',
      '.mjs': 'js',
      '.cjs': 'js',
      '.ts': 'ts',
      '.tsx': 'tsx',
      '.jsx': 'jsx',
      '.json': 'json',
      '.md': 'md',
      '.py': 'py',
      '.rb': 'rb',
      '.go': 'go',
      '.rs': 'rs',
      '.java': 'java',
      '.kt': 'kt',
      '.swift': 'swift',
      '.sh': 'bash',
      '.yml': 'yaml',
      '.yaml': 'yaml',
      '.toml': 'toml',
      '.css': 'css',
      '.html': 'html',
      '.xml': 'xml'
    }[ext] || ''
  );
}

function contextPriorityScore(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  const base = path.basename(normalized);
  const ext = extnameLower(normalized);

  let score = 0;

  if (normalized.includes('/completed/') || normalized.includes('/todo')) score += 90;
  if (normalized.includes('/.github/')) score += 70;
  if (base.startsWith('.')) score += 40;
  if (base === 'license' || base.startsWith('license.')) score += 60;
  if (base === 'readme.md') score += 10;

  const sourceExts = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.swift',
    '.css', '.html', '.json', '.yaml', '.yml', '.toml', '.sh'
  ]);
  if (sourceExts.has(ext)) score -= 20;
  if (['main.mjs', 'index.js', 'index.ts', 'app.js', 'app.ts', 'server.js', 'server.ts'].includes(base)) score -= 20;

  score += normalized.split('/').length;
  return score;
}

async function readSample(filePath, maxBytes) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(Math.max(1, maxBytes));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function assertExistingFileList(paths, { errorName, cwd = process.cwd() } = {}) {
  for (const item of Array.isArray(paths) ? paths : []) {
    const abs = normalizeAbsoluteInputPath(item, { cwd });
    if (!abs) continue;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) {
        const err = new Error(errorName);
        err.data = { path: abs, input: item };
        throw err;
      }
    } catch (error) {
      if (String(error?.message || '') === String(errorName || '')) throw error;
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        const err = new Error(errorName);
        err.data = { path: abs, input: item };
        throw err;
      }
      throw error;
    }
  }
}

function sampleLooksText(buf) {
  if (!buf || !buf.length) return true;
  let weird = 0;
  for (const byte of buf) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 14 && byte < 32)) weird += 1;
  }
  return weird / buf.length < 0.08;
}

async function walkPath(absPath, out, { maxFiles }) {
  if (out.length >= maxFiles) return;
  const st = await fs.lstat(absPath);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    const entries = await fs.readdir(absPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if ((entry.isDirectory() || entry.isSymbolicLink()) && IGNORE_DIRS.has(entry.name)) continue;
      await walkPath(path.join(absPath, entry.name), out, { maxFiles });
    }
    return;
  }
  if (st.isFile()) out.push({ absPath, size: st.size });
}

function chunkText(text, maxChunkChars, maxChunksPerFile) {
  const chunks = [];
  let offset = 0;
  while (offset < text.length && chunks.length < maxChunksPerFile) {
    const next = text.slice(offset, offset + maxChunkChars);
    chunks.push(next);
    offset += maxChunkChars;
  }
  return { chunks, truncated: offset < text.length };
}

function summarizeContext({ roots, filesScanned, inlineFiles, attachedFiles, omitted, usedChars, maxContextChars }) {
  const explicitAttachments = attachedFiles.filter((item) => item.reason === 'explicit');
  const autoAttachments = attachedFiles.filter((item) => item.reason !== 'explicit');
  const omittedByReason = {};
  for (const item of omitted) {
    const reason = String(item?.reason || 'unknown');
    omittedByReason[reason] = (omittedByReason[reason] || 0) + 1;
  }
  return {
    roots: roots.map((item) => item.input),
    filesScanned,
    inlineFileCount: inlineFiles.length,
    inlineFiles: inlineFiles.map((item) => item.path),
    inlineChunkCount: inlineFiles.reduce((sum, item) => sum + Number(item?.chunks || 0), 0),
    explicitAttachmentCount: explicitAttachments.length,
    explicitAttachments: explicitAttachments.map((item) => item.path),
    autoAttachmentCount: autoAttachments.length,
    autoAttachments: autoAttachments.map((item) => ({
      path: item.path,
      reason: item.reason,
      size: Number.isFinite(item.size) ? item.size : null
    })),
    omittedCount: omitted.length,
    omittedByReason,
    omittedPreview: omitted.slice(0, 10),
    contextCharsUsed: usedChars,
    contextCharsBudget: maxContextChars
  };
}

export async function prepareQueryContext({
  prompt,
  promptPrefix = '',
  attachments = [],
  contextPaths = [],
  cwd = process.cwd(),
  maxContextChars = 110_000,
  maxFiles = 80,
  maxFileChars = 18_000,
  maxChunkChars = 6_000,
  maxChunksPerFile = 3,
  maxInlineFiles = 18,
  maxAttachmentFiles = 10,
  maxBinaryAttachmentBytes = 12 * 1024 * 1024
} = {}) {
  const basePrompt = String(prompt || '');
  const basePrefix = String(promptPrefix || '').trim();
  const explicitAttachments = Array.isArray(attachments)
    ? attachments.map((p) => normalizeAbsoluteInputPath(p, { cwd })).filter(Boolean)
    : [];
  const inputs = Array.isArray(contextPaths) ? contextPaths.map((p) => String(p || '').trim()).filter(Boolean) : [];
  await assertExistingFileList(explicitAttachments, { errorName: 'missing_attachment_path', cwd });
  if (!inputs.length && !basePrefix) {
    const context = {
      roots: [],
      filesScanned: 0,
      inlineFiles: [],
      attachedFiles: explicitAttachments.map((p) => ({ path: p, reason: 'explicit' })),
      omitted: []
    };
    context.summary = summarizeContext({
      roots: context.roots,
      filesScanned: context.filesScanned,
      inlineFiles: context.inlineFiles,
      attachedFiles: context.attachedFiles,
      omitted: context.omitted,
      usedChars: 0,
      maxContextChars
    });
    return {
      prompt: basePrompt,
      attachments: explicitAttachments,
      context
    };
  }

  const roots = [];
  const files = [];
  for (const item of inputs) {
    const abs = path.resolve(cwd, item);
    roots.push({ input: item, path: abs });
    try {
      await walkPath(abs, files, { maxFiles });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const err = new Error('missing_context_path');
        err.data = { path: abs, input: item };
        throw err;
      }
      throw error;
    }
  }
  files.sort((a, b) => {
    const scoreDiff = contextPriorityScore(a.absPath) - contextPriorityScore(b.absPath);
    if (scoreDiff !== 0) return scoreDiff;
    return a.absPath.localeCompare(b.absPath);
  });

  const inlineBlocks = [];
  const attachedFiles = explicitAttachments.map((p) => ({ path: p, reason: 'explicit' }));
  const attachedSet = new Set(explicitAttachments);
  const inlineFiles = [];
  const omitted = [];
  let usedChars = 0;

  for (const file of files) {
    const rel = roots.length ? path.relative(path.dirname(roots[0].path), file.absPath) : path.basename(file.absPath);
    const named = rel && !rel.startsWith('..') ? rel : path.basename(file.absPath);
    if (looksBinaryByName(file.absPath)) {
      if (attachedFiles.length < maxAttachmentFiles && file.size <= maxBinaryAttachmentBytes && !attachedSet.has(file.absPath)) {
        attachedFiles.push({ path: file.absPath, reason: 'context-binary', size: file.size });
        attachedSet.add(file.absPath);
      } else {
        omitted.push({ path: named, reason: file.size > maxBinaryAttachmentBytes ? 'binary_too_large' : 'binary_limit' });
      }
      continue;
    }

    const sample = await readSample(file.absPath, Math.min(file.size || maxFileChars, maxFileChars));
    if (!sampleLooksText(sample)) {
      if (attachedFiles.length < maxAttachmentFiles && file.size <= maxBinaryAttachmentBytes && !attachedSet.has(file.absPath)) {
        attachedFiles.push({ path: file.absPath, reason: 'context-binary-sampled', size: file.size });
        attachedSet.add(file.absPath);
      } else {
        omitted.push({ path: named, reason: 'non_text' });
      }
      continue;
    }

    if (inlineFiles.length >= maxInlineFiles) {
      omitted.push({ path: named, reason: 'inline_limit' });
      continue;
    }

    const text = sample.toString('utf8').replace(/\u0000/g, '');
    const { chunks, truncated } = chunkText(text, maxChunkChars, maxChunksPerFile);
    const lang = codeFenceLang(file.absPath);
    const acceptedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const header = `### File: ${named}${chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length}${truncated && i === chunks.length - 1 ? '+' : ''})` : truncated ? ' (truncated)' : ''}\n`;
      const block = `${header}\`\`\`${lang}\n${chunks[i]}\n\`\`\`\n`;
      if (usedChars + block.length > maxContextChars) break;
      inlineBlocks.push(block);
      acceptedChunks.push(i + 1);
      usedChars += block.length;
    }
    if (acceptedChunks.length) {
      inlineFiles.push({ path: named, chunks: acceptedChunks.length, truncated: truncated || acceptedChunks.length < chunks.length });
    } else {
      omitted.push({ path: named, reason: 'context_budget' });
    }
  }

  const summaryLines = [];
  summaryLines.push('Agentify packed local context for this prompt.');
  if (roots.length) summaryLines.push(`Roots: ${roots.map((r) => r.input).join(', ')}`);
  summaryLines.push(`Files scanned: ${files.length}`);
  if (inlineFiles.length) summaryLines.push(`Inline text files: ${inlineFiles.map((f) => f.path).join(', ')}`);
  if (attachedFiles.length) {
    const auto = attachedFiles.filter((f) => f.reason !== 'explicit').map((f) => path.basename(f.path));
    if (auto.length) summaryLines.push(`Auto-attached binary/image files: ${auto.join(', ')}`);
  }
  if (omitted.length) {
    const preview = omitted.slice(0, 10).map((f) => `${f.path} (${f.reason})`).join(', ');
    summaryLines.push(`Omitted: ${preview}${omitted.length > 10 ? ` +${omitted.length - 10} more` : ''}`);
  }

  const parts = [];
  if (basePrefix) parts.push(basePrefix);
  if (inputs.length) {
    parts.push(`## Packed Context Summary\n${summaryLines.map((line) => `- ${line}`).join('\n')}`);
    if (inlineBlocks.length) parts.push(`## Packed File Contents\n${inlineBlocks.join('\n')}`.trim());
  }
  parts.push(basePrompt);

  const context = {
    roots,
    filesScanned: files.length,
    inlineFiles,
    attachedFiles,
    omitted
  };
  context.summary = summarizeContext({
    roots,
    filesScanned: files.length,
    inlineFiles,
    attachedFiles,
    omitted,
    usedChars,
    maxContextChars
  });

  return {
    prompt: parts.filter(Boolean).join('\n\n').trim(),
    attachments: Array.from(new Set(attachedFiles.map((item) => path.resolve(item.path)))),
    context
  };
}
