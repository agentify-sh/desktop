import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { writeToken } from './state.mjs';
import { ensureArtifactsDir, listArtifacts, registerArtifact, artifactsRoot } from './artifact-store.mjs';
import { deleteBundle, getBundle, listBundles, saveBundle } from './bundle-store.mjs';
import { assertWithin } from './orchestrator/security.mjs';
import { prepareQueryContext } from './context-packer.mjs';

function isLoopback(remoteAddress) {
  const a = String(remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store, max-age=0',
    'access-control-allow-origin': 'http://127.0.0.1',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(data);
}

async function parseBody(req, { maxBytes = 2_000_000 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error('body_too_large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }
}

function authOk(req, token) {
  const hdr = String(req.headers.authorization || '');
  if (!hdr.startsWith('Bearer ')) return false;
  return hdr.slice('Bearer '.length).trim() === token;
}

function mapErrorToHttp(error) {
  const msg = String(error?.message || '');
  if (msg === 'body_too_large') return { code: 413, body: { error: 'body_too_large' } };
  if (msg === 'invalid_json') return { code: 400, body: { error: 'invalid_json' } };
  if (msg === 'invalid_vendor') return { code: 400, body: { error: 'invalid_vendor', data: error?.data || null } };
  if (msg === 'invalid_artifact_mode') return { code: 400, body: { error: 'invalid_artifact_mode', data: error?.data || null } };
  if (msg === 'relative_path_not_allowed') return { code: 400, body: { error: 'relative_path_not_allowed', data: error?.data || null } };
  if (msg === 'missing_url') return { code: 400, body: { error: 'missing_url' } };
  if (msg === 'missing_prompt') return { code: 400, body: { error: 'missing_prompt' } };
  if (msg === 'missing_attachment_path') return { code: 400, body: { error: 'missing_attachment_path', data: error?.data || null } };
  if (msg === 'missing_context_path') return { code: 400, body: { error: 'missing_context_path', data: error?.data || null } };
  if (msg === 'missing_bundle_name') return { code: 400, body: { error: 'missing_bundle_name' } };
  if (msg === 'bundle_name_too_large') return { code: 400, body: { error: 'bundle_name_too_large' } };
  if (msg === 'bundle_not_found') return { code: 404, body: { error: 'bundle_not_found', data: error?.data || null } };
  if (msg === 'missing_watch_folder_path') return { code: 400, body: { error: 'missing_watch_folder_path' } };
  if (msg === 'missing_watch_folder_name') return { code: 400, body: { error: 'missing_watch_folder_name' } };
  if (msg === 'watch_folder_not_directory') return { code: 400, body: { error: 'watch_folder_not_directory' } };
  if (msg === 'watch_folder_overlaps_existing') return { code: 409, body: { error: 'watch_folder_overlaps_existing' } };
  if (msg === 'watch_folder_cannot_be_filesystem_root') return { code: 400, body: { error: 'watch_folder_cannot_be_filesystem_root' } };
  if (msg === 'watch_folder_not_found') return { code: 404, body: { error: 'watch_folder_not_found' } };
  if (msg === 'prompt_too_large') return { code: 400, body: { error: 'prompt_too_large' } };
  if (msg === 'missing_tabId') return { code: 400, body: { error: 'missing_tabId' } };
  if (msg === 'missing_key') return { code: 400, body: { error: 'missing_key' } };
  if (msg === 'tab_busy') return { code: 409, body: { error: 'tab_busy', data: error?.data || null } };
  if (msg === 'key_vendor_mismatch') return { code: 409, body: { error: 'key_vendor_mismatch' } };
  if (msg === 'tab_not_found') return { code: 404, body: { error: 'tab_not_found' } };
  if (msg === 'tab_closed') return { code: 409, body: { error: 'tab_closed' } };
  if (msg === 'default_tab_protected') return { code: 409, body: { error: 'default_tab_protected' } };
  if (msg === 'max_tabs_reached') return { code: 409, body: { error: 'max_tabs_reached' } };
  if (msg === 'rate_limited') return { code: 429, body: { error: 'rate_limited', ...(error?.data || {}) } };
  if (msg === 'query_aborted') return { code: 409, body: { error: 'query_aborted', data: error?.data || null } };
  if (msg === 'timeout_waiting_for_prompt') return { code: 408, body: { error: 'timeout_waiting_for_prompt', data: error?.data || null } };
  if (msg === 'timeout_waiting_for_response') return { code: 408, body: { error: 'timeout_waiting_for_response', data: error?.data || null } };
  if (msg === 'artifacts_folder_open_failed') return { code: 500, body: { error: 'artifacts_folder_open_failed', data: error?.data || null } };
  if (msg === 'artifact_save_failed') return { code: 500, body: { error: 'artifact_save_failed', data: error?.data || null } };
  return null;
}

function getTabIdFromUrl(url) {
  const tabId = String(url.searchParams.get('tabId') || '').trim();
  return tabId || null;
}

function envShowTabsDefault() {
  const v = String(process.env.AGENTIFY_DESKTOP_SHOW_TABS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function positiveIntOr(value, fallback, max = Number.POSITIVE_INFINITY) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function normalizeAbsolutePathList(items, { field } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    if (!path.isAbsolute(trimmed)) {
      const err = new Error('relative_path_not_allowed');
      err.data = { field: field || null, path: trimmed };
      throw err;
    }
    const resolved = path.resolve(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function normalizeAbsoluteSinglePath(value, { field } = {}) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (!path.isAbsolute(trimmed)) {
    const err = new Error('relative_path_not_allowed');
    err.data = { field: field || null, path: trimmed };
    throw err;
  }
  return path.resolve(trimmed);
}

async function runExclusive(controller, fn) {
  if (controller && typeof controller.runExclusive === 'function') return await controller.runExclusive(fn);
  return await fn();
}

function normalizeVendorToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function resolveVendor({ body, vendors = [] } = {}) {
  const raw = String(body?.vendorId || body?.model || '').trim();
  if (!raw) return null;
  const token = normalizeVendorToken(raw);
  const rows = Array.isArray(vendors) ? vendors : [];
  const found = rows.find((item) => {
    const id = normalizeVendorToken(item?.id || '');
    const name = normalizeVendorToken(item?.name || '');
    return token && (token === id || token === name);
  });
  if (!found) {
    const err = new Error('invalid_vendor');
    err.data = { vendor: raw };
    throw err;
  }
  return found;
}

function defaultVendor(vendors = []) {
  const rows = Array.isArray(vendors) ? vendors : [];
  return rows.find((item) => String(item?.id || '').trim() === 'chatgpt') || rows[0] || null;
}

function listedTabMatchesVendor(tab, vendor) {
  if (!vendor) return true;
  const tabVendor = normalizeVendorToken(tab?.vendorId || '');
  const requestedVendor = normalizeVendorToken(vendor?.id || '');
  if (tabVendor && requestedVendor) return tabVendor === requestedVendor;
  const tabUrl = String(tab?.url || '').trim();
  const requestedUrl = String(vendor?.url || '').trim();
  if (tabUrl && requestedUrl) return tabUrl.startsWith(requestedUrl) || requestedUrl.startsWith(tabUrl);
  return false;
}

async function resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault = false, createIfMissing = true, vendors = [] }) {
  const tabId = (body?.tabId ? String(body.tabId).trim() : '') || getTabIdFromUrl(url) || null;
  const key = (body?.key ? String(body.key).trim() : '') || null;
  const name = (body?.name ? String(body.name).trim() : '') || null;
  const explicitVendor = resolveVendor({ body, vendors });
  const vendor = explicitVendor || defaultVendor(vendors);
  if (tabId) return tabId;
  if (key) {
    if (!createIfMissing) {
      const existing = (tabs.listTabs?.() || []).find((t) => t?.key === key);
      if (explicitVendor && existing?.id && !listedTabMatchesVendor(existing, explicitVendor)) throw new Error('key_vendor_mismatch');
      if (existing?.id) return existing.id;
      throw new Error('tab_not_found');
    }
    return await tabs.ensureTab({
      key,
      name,
      show: envShowTabsDefault() || showTabsByDefault,
      url: vendor?.url,
      vendorId: vendor?.id,
      vendorName: vendor?.name
    });
  }
  if (explicitVendor) {
    const rows = Array.isArray(tabs.listTabs?.()) ? tabs.listTabs() : [];
    const defaultTab = rows.find((item) => String(item?.id || '') === String(defaultTabId || '')) || null;
    if (listedTabMatchesVendor(defaultTab, explicitVendor)) return defaultTabId;
    if (!createIfMissing) throw new Error('tab_not_found');
    return await tabs.ensureTab({
      key: `vendor:${explicitVendor.id}`,
      name: explicitVendor.name || explicitVendor.id,
      show: envShowTabsDefault() || showTabsByDefault,
      url: explicitVendor.url,
      vendorId: explicitVendor.id,
      vendorName: explicitVendor.name
    });
  }
  return defaultTabId;
}

function getTabMeta(tabs, tabId) {
  const rows = Array.isArray(tabs?.listTabs?.()) ? tabs.listTabs() : [];
  return rows.find((row) => String(row?.id || '') === String(tabId || '')) || null;
}

function contextBudgetForVendor(vendorId) {
  const key = String(vendorId || 'chatgpt').trim().toLowerCase() || 'chatgpt';
  const presets = {
    chatgpt: {
      maxContextChars: 110_000,
      maxFiles: 80,
      maxFileChars: 18_000,
      maxChunkChars: 6_000,
      maxChunksPerFile: 3,
      maxInlineFiles: 18,
      maxAttachmentFiles: 10
    },
    claude: {
      maxContextChars: 140_000,
      maxFiles: 100,
      maxFileChars: 22_000,
      maxChunkChars: 7_500,
      maxChunksPerFile: 3,
      maxInlineFiles: 20,
      maxAttachmentFiles: 12
    },
    gemini: {
      maxContextChars: 90_000,
      maxFiles: 70,
      maxFileChars: 16_000,
      maxChunkChars: 5_500,
      maxChunksPerFile: 3,
      maxInlineFiles: 16,
      maxAttachmentFiles: 10
    },
    aistudio: {
      maxContextChars: 120_000,
      maxFiles: 90,
      maxFileChars: 20_000,
      maxChunkChars: 6_500,
      maxChunksPerFile: 3,
      maxInlineFiles: 18,
      maxAttachmentFiles: 12
    },
    perplexity: {
      maxContextChars: 70_000,
      maxFiles: 55,
      maxFileChars: 12_000,
      maxChunkChars: 4_500,
      maxChunksPerFile: 2,
      maxInlineFiles: 12,
      maxAttachmentFiles: 8
    },
    grok: {
      maxContextChars: 80_000,
      maxFiles: 60,
      maxFileChars: 14_000,
      maxChunkChars: 5_000,
      maxChunksPerFile: 2,
      maxInlineFiles: 14,
      maxAttachmentFiles: 8
    }
  };
  return presets[key] || presets.chatgpt;
}

async function saveArtifactsForTab({
  stateDir,
  tabs,
  tabId,
  controller,
  mode = 'images',
  maxImages = 6,
  maxFiles = 6
}) {
  const normalizedMode = String(mode || 'images').trim().toLowerCase();
  if (!['images', 'files', 'all'].includes(normalizedMode)) {
    const err = new Error('invalid_artifact_mode');
    err.data = { mode };
    throw err;
  }
  const meta = getTabMeta(tabs, tabId);
  const outDir = await ensureArtifactsDir({
    stateDir,
    tabId,
    tabKey: meta?.key || null,
    vendorId: meta?.vendorId || null
  });
  const realOutDir = await fs.realpath(outDir);
  const candidates = [];

  if ((normalizedMode === 'images' || normalizedMode === 'all') && typeof controller.downloadLastAssistantImages === 'function') {
    const images = await controller.downloadLastAssistantImages({ maxImages, outDir });
    for (const item of images || []) {
      candidates.push({
        kind: 'image',
        filePath: item?.path,
        originalName: item?.name || null,
        mime: item?.mime || null,
        source: item?.source || null,
        meta: { alt: item?.alt || null }
      });
    }
  }

  if ((normalizedMode === 'files' || normalizedMode === 'all') && typeof controller.downloadLastAssistantFiles === 'function') {
    const files = await controller.downloadLastAssistantFiles({ maxFiles, outDir });
    for (const item of files || []) {
      candidates.push({
        kind: 'file',
        filePath: item?.path,
        originalName: item?.name || null,
        mime: item?.mime || null,
        source: item?.source || null,
        meta: null
      });
    }
  }

  for (const item of candidates) {
    if (!String(item?.filePath || '').trim()) {
      const err = new Error('artifact_save_failed');
      err.data = { reason: 'missing_artifact_path', kind: item?.kind || null };
      throw err;
    }
    const filePath = path.resolve(String(item.filePath).trim());
    let stat = null;
    let realFilePath = null;
    try {
      stat = await fs.lstat(filePath);
      if (!stat.isSymbolicLink()) {
        realFilePath = await fs.realpath(filePath);
      }
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        const err = new Error('artifact_save_failed');
        err.data = { reason: 'missing_artifact_file', kind: item?.kind || null, filePath };
        throw err;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const err = new Error('artifact_save_failed');
      err.data = { reason: 'artifact_symlink_not_allowed', kind: item?.kind || null, filePath };
      throw err;
    }
    if (!stat.isFile()) {
      const err = new Error('artifact_save_failed');
      err.data = { reason: 'artifact_path_not_file', kind: item?.kind || null, filePath };
      throw err;
    }
    if (Number(stat.nlink || 1) > 1) {
      const err = new Error('artifact_save_failed');
      err.data = { reason: 'artifact_link_count_not_allowed', kind: item?.kind || null, filePath };
      throw err;
    }
    try {
      assertWithin({ filePath: realFilePath || filePath, allowedRoots: [realOutDir] });
    } catch (error) {
      if (String(error?.message || '') === 'path_not_allowed') {
        const err = new Error('artifact_save_failed');
        err.data = { reason: 'artifact_outside_output_dir', kind: item?.kind || null, filePath, outDir };
        throw err;
      }
      throw error;
    }
  }

  const saved = [];
  for (const item of candidates) {
    saved.push(
      await registerArtifact({
        stateDir,
        tabId,
        tabKey: meta?.key || null,
        vendorId: meta?.vendorId || null,
        kind: item.kind,
        filePath: item.filePath,
        originalName: item.originalName,
        mime: item.mime,
        source: item.source,
        meta: item.meta
      })
    );
  }

  return { dir: outDir, items: saved };
}

function mergeQueryInputs({ bundle, promptPrefix, attachments, contextPaths }) {
  const mergedAttachments = normalizeAbsolutePathList([...(bundle?.attachments || []), ...(attachments || [])], {
    field: 'attachments'
  });
  const mergedContextPaths = normalizeAbsolutePathList([...(bundle?.contextPaths || []), ...(contextPaths || [])], {
    field: 'contextPaths'
  });
  const mergedPrefix = [String(bundle?.promptPrefix || '').trim(), String(promptPrefix || '').trim()].filter(Boolean).join('\n\n');
  return { promptPrefix: mergedPrefix, attachments: mergedAttachments, contextPaths: mergedContextPaths };
}

export function startHttpApi({
  host = '127.0.0.1',
  port,
  token,
  tabs,
  defaultTabId,
  vendors = [],
  serverId,
  stateDir,
  onShow,
  onHide,
  onShutdown,
  onOpenArtifactsFolder,
  onWatchFoldersList,
  onAddWatchFolder,
  onRemoveWatchFolder,
  onOpenWatchFolder,
  onScanWatchFolder,
  getStatus,
  getSettings,
  onRuntimeChanged
}) {
  const tokenRef = typeof token === 'string' ? { current: token } : token;

  // Governor state (per-desktop instance).
  const inflight = { queries: 0 };
  const activeQueries = new Map(); // tabId -> runtime status
  const activeScopes = new Map(); // request scope -> runtime status
  const lastOutcomes = new Map(); // tabId -> last finished outcome
  const lastQueryAt = new Map(); // tabId -> ms
  let lastAnyQueryAt = 0;
  const bucket = { tokens: null, lastRefillAt: Date.now(), lastCap: null };

  const getGovernor = async () => {
    const s = (await getSettings?.().catch(() => null)) || {};
    const maxInflightQueries = Math.max(1, Number(s.maxInflightQueries || 2) || 2);
    const maxQueriesPerMinute = Math.max(1, Number(s.maxQueriesPerMinute || 12) || 12);
    const minTabGapMs = Math.max(0, Number(s.minTabGapMs || 0) || 0);
    const minGlobalGapMs = Math.max(0, Number(s.minGlobalGapMs || 0) || 0);
    const showTabsByDefault = !!s.showTabsByDefault;
    return { maxInflightQueries, maxQueriesPerMinute, minTabGapMs, minGlobalGapMs, showTabsByDefault };
  };

  const checkAndConsumeQueryBudget = ({ tabId, governor }) => {
    const now = Date.now();
    if (inflight.queries >= governor.maxInflightQueries) {
      const err = new Error('rate_limited');
      err.data = { reason: 'max_inflight', retryAfterMs: 250 };
      throw err;
    }

    const lastTab = lastQueryAt.get(tabId) || 0;
    const tabWait = governor.minTabGapMs - (now - lastTab);
    if (tabWait > 0) {
      const err = new Error('rate_limited');
      err.data = { reason: 'tab_gap', retryAfterMs: tabWait };
      throw err;
    }

    const globalWait = governor.minGlobalGapMs - (now - lastAnyQueryAt);
    if (globalWait > 0) {
      const err = new Error('rate_limited');
      err.data = { reason: 'global_gap', retryAfterMs: globalWait };
      throw err;
    }

    // Token bucket (per minute).
    const cap = governor.maxQueriesPerMinute;
    const ratePerMs = cap / 60_000;
    const elapsed = Math.max(0, now - bucket.lastRefillAt);
    if (bucket.tokens == null) bucket.tokens = cap;
    if (bucket.lastCap == null) bucket.lastCap = cap;
    if (cap !== bucket.lastCap) {
      if (cap > bucket.lastCap) bucket.tokens = Math.min(cap, bucket.tokens + (cap - bucket.lastCap));
      else bucket.tokens = Math.min(cap, bucket.tokens);
      bucket.lastCap = cap;
    }
    bucket.tokens = Math.min(cap, bucket.tokens + elapsed * ratePerMs);
    bucket.lastRefillAt = now;

    if (bucket.tokens < 1) {
      const needed = 1 - bucket.tokens;
      const retryAfterMs = Math.ceil(needed / ratePerMs);
      const err = new Error('rate_limited');
      err.data = { reason: 'qpm', retryAfterMs: Math.max(50, retryAfterMs) };
      throw err;
    }

    bucket.tokens -= 1;
    lastQueryAt.set(tabId, now);
    lastAnyQueryAt = now;
  };

  const trimPreview = (value, max = 140) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };

  const requestSourceForBody = (body) => {
    const raw = String(body?.source || '').trim().toLowerCase();
    if (raw === 'mcp' || raw === 'cli') return 'mcp';
    if (raw === 'ui') return 'ui';
    return 'http';
  };

  const blockedLabelForKind = (kind) => {
    if (kind === 'login') return 'Needs sign-in';
    if (kind === 'captcha') return 'Needs CAPTCHA';
    if (kind === 'blocked') return 'Access blocked';
    if (kind === 'ui') return 'Needs page ready';
    return 'Needs attention';
  };

  const outcomeFromError = (error, op) => {
    const message = String(error?.message || 'error');
    const detail = error?.data || null;
    const base = {
      source: op?.source || 'http',
      kind: op?.kind || 'query',
      finishedAt: Date.now(),
      durationMs: Math.max(0, Date.now() - Number(op?.startedAt || Date.now()))
    };
    if (message === 'query_aborted') {
      return {
        ...base,
        status: 'stopped',
        label: 'Stopped',
        detail: 'Break-glass stop requested.'
      };
    }
    if (message === 'timeout_waiting_for_prompt') {
      const kind = String(detail?.kind || '').trim() || 'blocked';
      return {
        ...base,
        status: 'blocked',
        label: blockedLabelForKind(kind),
        detail: kind === 'login'
          ? 'Waiting for sign-in in the provider window.'
          : kind === 'captcha'
            ? 'Waiting for CAPTCHA or human verification.'
            : 'Waiting for the page to become ready.',
        blocked: true,
        blockedKind: kind
      };
    }
    if (message === 'timeout_waiting_for_response') {
      return {
        ...base,
        status: 'error',
        label: 'Response timed out',
        detail: 'The provider did not finish responding in time.'
      };
    }
    if (message === 'rate_limited') {
      return {
        ...base,
        status: 'error',
        label: 'Rate limited',
        detail: detail?.reason ? `Governor blocked this run (${detail.reason}).` : 'Governor blocked this run.'
      };
    }
    if (message === 'tab_busy') {
      return {
        ...base,
        status: 'error',
        label: 'Tab busy',
        detail: 'Another run is already active on this tab.'
      };
    }
    return {
      ...base,
      status: 'error',
      label: 'Run failed',
      detail: message
    };
  };

  const runtimeSnapshot = () => ({
    inflightQueries: inflight.queries,
    activeQueries: Array.from(activeQueries.values())
      .map((item) => ({ ...item }))
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)),
    lastOutcomes: Array.from(lastOutcomes.entries())
      .map(([tabId, item]) => ({ tabId, ...item }))
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
  });

  const emitRuntimeChanged = () => {
    try {
      onRuntimeChanged?.(runtimeSnapshot());
    } catch {}
  };

  const setActiveQuery = (tabId, item) => {
    if (!tabId || !item) return;
    activeQueries.set(tabId, { ...item, updatedAt: Date.now() });
    emitRuntimeChanged();
  };

  const requestScopeForBody = (body) => {
    const tabId = body?.tabId ? String(body.tabId).trim() : '';
    if (tabId) return `tab:${tabId}`;
    const key = body?.key ? String(body.key).trim() : '';
    if (key) return `key:${key}`;
    const vendorId = body?.vendorId ? String(body.vendorId).trim() : '';
    if (vendorId) return `vendor:${vendorId}`;
    const model = body?.model ? String(body.model).trim() : '';
    if (model) return `vendor:${model}`;
    return `tab:${defaultTabId}`;
  };

  const assertTabNotBusy = (tabId) => {
    const current = activeQueries.get(tabId);
    if (!current) return;
    const err = new Error('tab_busy');
    err.data = {
      tabId,
      activeQuery: { ...current }
    };
    throw err;
  };

  const assertScopeNotBusy = (scope) => {
    const current = activeScopes.get(scope);
    if (!current) return;
    const err = new Error('tab_busy');
    err.data = {
      scope,
      activeQuery: { ...current }
    };
    throw err;
  };

  const reserveScope = (scope, item) => {
    if (!scope || !item) return;
    activeScopes.set(scope, { ...item });
  };

  const clearScope = (scope, expectedId = null) => {
    if (!scope) return;
    const current = activeScopes.get(scope);
    if (!current) return;
    if (expectedId && current.id !== expectedId) return;
    activeScopes.delete(scope);
  };

  const patchActiveQuery = (tabId, patch) => {
    const current = activeQueries.get(tabId);
    if (!current) return null;
    const next = { ...current, ...(patch || {}), updatedAt: Date.now() };
    activeQueries.set(tabId, next);
    emitRuntimeChanged();
    return next;
  };

  const setLastOutcome = (tabId, item) => {
    if (!tabId || !item) return;
    lastOutcomes.set(tabId, { ...item, updatedAt: Date.now() });
    emitRuntimeChanged();
  };

  const clearActiveQuery = (tabId, expectedId = null) => {
    const current = activeQueries.get(tabId);
    if (!current) return;
    if (expectedId && current.id !== expectedId) return;
    activeQueries.delete(tabId);
    emitRuntimeChanged();
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) return sendJson(res, 403, { error: 'forbidden' });
      if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, serverId: serverId || null });

      if (!authOk(req, tokenRef.current)) return sendJson(res, 401, { error: 'unauthorized' });

      const governor = await getGovernor();

      if (url.pathname === '/status' && req.method === 'GET') {
        const statusBody = {
          tabId: url.searchParams.get('tabId') || '',
          key: url.searchParams.get('key') || '',
          vendorId: url.searchParams.get('vendorId') || '',
          model: url.searchParams.get('model') || ''
        };
        const hasScopedTab = !!(statusBody.tabId || statusBody.key || statusBody.vendorId || statusBody.model);
        const tabId = hasScopedTab
          ? await resolveTab({ tabs, defaultTabId, body: statusBody, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: false, vendors })
          : defaultTabId;
        const st = await getStatus({ tabId });
        return sendJson(res, 200, {
          ...st,
          activeQuery: activeQueries.get(tabId) || null,
          runtime: runtimeSnapshot()
        });
      }

      if (url.pathname === '/show' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
        await onShow?.({ tabId });
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/hide' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: false, vendors });
        await onHide?.({ tabId });
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/tabs' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, tabs: tabs.listTabs(), defaultTabId });
      }
      if (url.pathname === '/bundles/list' && req.method === 'GET') {
        const bundles = await listBundles(stateDir);
        return sendJson(res, 200, { ok: true, bundles });
      }
      if (url.pathname === '/watch-folders/list' && req.method === 'GET') {
        const folders = (await onWatchFoldersList?.()) || [];
        return sendJson(res, 200, { ok: true, folders });
      }
      if (url.pathname === '/watch-folders/add' && req.method === 'POST') {
        const body = await parseBody(req);
        const folder = await onAddWatchFolder?.({
          name: String(body.name || '').trim(),
          folderPath: normalizeAbsoluteSinglePath(body.path, { field: 'path' })
        });
        return sendJson(res, 200, { ok: true, folder });
      }
      if (url.pathname === '/watch-folders/delete' && req.method === 'POST') {
        const body = await parseBody(req);
        const deleted = await onRemoveWatchFolder?.({ name: String(body.name || '').trim() });
        return sendJson(res, 200, { ok: true, deleted: !!deleted });
      }
      if (url.pathname === '/tabs/create' && req.method === 'POST') {
        const body = await parseBody(req);
        const key = (body.key ? String(body.key).trim() : '') || null;
        const name = (body.name ? String(body.name).trim() : '') || null;
        const show = typeof body.show === 'boolean' ? body.show : envShowTabsDefault() || governor.showTabsByDefault;
        const vendor = resolveVendor({ body, vendors }) || defaultVendor(vendors);
        const tabId = key
          ? await tabs.ensureTab({ key, name, show, url: vendor?.url, vendorId: vendor?.id, vendorName: vendor?.name })
          : await tabs.createTab({ name, show, url: vendor?.url, vendorId: vendor?.id, vendorName: vendor?.name });
        if (show) await onShow?.({ tabId }).catch(() => {});
        return sendJson(res, 200, { ok: true, tabId });
      }
      if (url.pathname === '/tabs/close' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = (body.tabId ? String(body.tabId).trim() : '') || null;
        if (!tabId) return sendJson(res, 400, { error: 'missing_tabId' });
        if (tabId === defaultTabId) throw new Error('default_tab_protected');
        await tabs.closeTab(tabId);
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/shutdown' && req.method === 'POST') {
        // Must be authenticated. Best-effort: return OK then let caller quit the app.
        const body = await parseBody(req);
        const scope = String(body.scope || 'app');
        if (scope !== 'app') return sendJson(res, 400, { error: 'invalid_scope' });
        sendJson(res, 200, { ok: true });
        await onHide?.({ tabId: defaultTabId }).catch(() => {});
        await onShutdown?.().catch(() => {});
        return;
      }

      if (url.pathname === '/rotate-token' && req.method === 'POST') {
        if (!stateDir) return sendJson(res, 500, { error: 'misconfigured_stateDir' });
        const next = crypto.randomBytes(24).toString('hex');
        await writeToken(next, stateDir);
        tokenRef.current = next;
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/navigate' && req.method === 'POST') {
        const body = await parseBody(req);
        const to = String(body.url || '').trim();
        if (!to) return sendJson(res, 400, { error: 'missing_url' });
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
        const controller = tabs.getControllerById(tabId);
        await runExclusive(controller, async () => controller.navigate(to));
        return sendJson(res, 200, { ok: true, tabId, url: await controller.getUrl() });
      }

      if (url.pathname === '/ensure-ready' && req.method === 'POST') {
        const body = await parseBody(req);
        const timeoutMs = positiveIntOr(body.timeoutMs, 10 * 60_000, 30 * 60_000);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
        const controller = tabs.getControllerById(tabId);
        const st = await runExclusive(controller, async () => controller.ensureReady({ timeoutMs }));
        return sendJson(res, 200, { ok: true, tabId, state: st });
      }

      if (url.pathname === '/query' && req.method === 'POST') {
        const body = await parseBody(req, { maxBytes: 5_000_000 });
        const timeoutMs = positiveIntOr(body.timeoutMs, 10 * 60_000, 30 * 60_000);
        const prompt = String(body.prompt || '');
        if (!prompt.trim()) throw new Error('missing_prompt');
        if (prompt.length > 200_000) throw new Error('prompt_too_large');
        const source = requestSourceForBody(body);
        const scope = requestScopeForBody(body);
        assertScopeNotBusy(scope);
        const attachments = Array.isArray(body.attachments) ? body.attachments.map(String) : [];
        const contextPaths = Array.isArray(body.contextPaths) ? body.contextPaths.map(String) : [];
        const promptPrefix = String(body.promptPrefix || '');
        const bundleName = String(body.bundleName || '').trim() || null;
        const op = {
          id: crypto.randomUUID(),
          kind: 'query',
          tabId: null,
          startedAt: Date.now(),
          promptPreview: trimPreview(prompt),
          source,
          phase: 'resolving_tab',
          stopRequested: false,
          stopRequestedAt: null,
          blocked: false,
          blockedKind: null,
          scope
        };
        reserveScope(scope, op);
        let tabId = null;
        try {
          tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
          assertTabNotBusy(tabId);
          op.tabId = tabId;
          setActiveQuery(tabId, op);
          const tabMeta = getTabMeta(tabs, tabId);
          const vendorBudget = contextBudgetForVendor(tabMeta?.vendorId || 'chatgpt');
          try {
            patchActiveQuery(tabId, { phase: 'preparing_context', blocked: false, blockedKind: null });
            const bundle = bundleName ? await getBundle(stateDir, bundleName) : null;
            if (bundleName && !bundle) {
              const err = new Error('bundle_not_found');
              err.data = { name: bundleName };
              throw err;
            }
            const merged = mergeQueryInputs({ bundle, promptPrefix, attachments, contextPaths });
            const effectiveBudget = {
              maxContextChars: positiveIntOr(body.maxContextChars, vendorBudget.maxContextChars, 500_000),
              maxFiles: positiveIntOr(body.maxContextFiles, vendorBudget.maxFiles, 500),
              maxFileChars: positiveIntOr(body.maxContextFileChars, vendorBudget.maxFileChars, 100_000),
              maxChunkChars: positiveIntOr(body.maxContextChunkChars, vendorBudget.maxChunkChars, 20_000),
              maxChunksPerFile: positiveIntOr(body.maxContextChunksPerFile, vendorBudget.maxChunksPerFile, 20),
              maxInlineFiles: positiveIntOr(body.maxContextInlineFiles, vendorBudget.maxInlineFiles, 100),
              maxAttachmentFiles: positiveIntOr(body.maxContextAttachments, vendorBudget.maxAttachmentFiles, 50)
            };
            const packed = await prepareQueryContext({
              prompt,
              promptPrefix: merged.promptPrefix,
              attachments: merged.attachments,
              contextPaths: merged.contextPaths,
              maxContextChars: effectiveBudget.maxContextChars,
              maxFiles: effectiveBudget.maxFiles,
              maxFileChars: effectiveBudget.maxFileChars,
              maxChunkChars: effectiveBudget.maxChunkChars,
              maxChunksPerFile: effectiveBudget.maxChunksPerFile,
              maxInlineFiles: effectiveBudget.maxInlineFiles,
              maxAttachmentFiles: effectiveBudget.maxAttachmentFiles
            });
            checkAndConsumeQueryBudget({ tabId, governor });
            inflight.queries += 1;
            const controller = tabs.getControllerById(tabId);
            const result = await runExclusive(controller, async () =>
              controller.query({
                prompt: packed.prompt,
                attachments: packed.attachments,
                timeoutMs,
                onProgress: (patch) => patchActiveQuery(tabId, patch)
              })
            );
            setLastOutcome(tabId, {
              status: 'success',
              label: 'Response received',
              detail: result?.text ? trimPreview(result.text, 180) : 'The provider returned a response.',
              source,
              kind: 'query',
              finishedAt: Date.now(),
              durationMs: Math.max(0, Date.now() - op.startedAt)
            });
            return sendJson(res, 200, {
              ok: true,
              tabId,
              result,
              packedContext: packed.context,
              packedContextSummary: packed.context?.summary || null,
              packedContextBudget: effectiveBudget,
              bundle
            });
          } catch (error) {
            setLastOutcome(tabId, outcomeFromError(error, op));
            throw error;
          } finally {
            clearActiveQuery(tabId, op.id);
            inflight.queries = Math.max(0, inflight.queries - 1);
          }
        } finally {
          clearScope(scope, op.id);
        }
      }

      if (url.pathname === '/send' && req.method === 'POST') {
        const body = await parseBody(req, { maxBytes: 5_000_000 });
        const timeoutMs = positiveIntOr(body.timeoutMs, 3 * 60_000, 30 * 60_000);
        const text = String(body.text || '');
        if (!text.trim()) throw new Error('missing_prompt');
        if (text.length > 200_000) throw new Error('prompt_too_large');
        const source = requestSourceForBody(body);
        const scope = requestScopeForBody(body);
        assertScopeNotBusy(scope);
        const stopAfterSend = !!body.stopAfterSend;
        const op = {
          id: crypto.randomUUID(),
          kind: 'send',
          tabId: null,
          startedAt: Date.now(),
          promptPreview: trimPreview(text),
          source,
          phase: 'resolving_tab',
          stopRequested: false,
          stopRequestedAt: null,
          blocked: false,
          blockedKind: null,
          scope
        };
        reserveScope(scope, op);
        let tabId = null;
        try {
          tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
          assertTabNotBusy(tabId);
          op.tabId = tabId;
          setActiveQuery(tabId, op);
          checkAndConsumeQueryBudget({ tabId, governor });
          inflight.queries += 1;
          const controller = tabs.getControllerById(tabId);
          const result = await runExclusive(controller, async () =>
            controller.send({
              text,
              timeoutMs,
              stopAfterSend,
              onProgress: (patch) => patchActiveQuery(tabId, patch)
            })
          );
          setLastOutcome(tabId, {
            status: 'success',
            label: 'Sent',
            detail: 'Prompt sent successfully.',
            source,
            kind: 'send',
            finishedAt: Date.now(),
            durationMs: Math.max(0, Date.now() - op.startedAt)
          });
          return sendJson(res, 200, { ok: true, tabId, result });
        } catch (error) {
          if (tabId) setLastOutcome(tabId, outcomeFromError(error, op));
          throw error;
        } finally {
          if (tabId) clearActiveQuery(tabId, op.id);
          clearScope(scope, op.id);
          inflight.queries = Math.max(0, inflight.queries - 1);
        }
      }

      if (url.pathname === '/query/stop' && req.method === 'POST') {
        const body = await parseBody(req);
        const hasScopedTab = !!(
          (body?.tabId ? String(body.tabId).trim() : '') ||
          (body?.key ? String(body.key).trim() : '') ||
          (body?.vendorId ? String(body.vendorId).trim() : '') ||
          (body?.model ? String(body.model).trim() : '')
        );
        const tabId = hasScopedTab
          ? await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: false, vendors })
          : defaultTabId;
        const active = patchActiveQuery(tabId, { stopRequested: true, stopRequestedAt: Date.now() }) || null;
        const controller = tabs.getControllerById(tabId);
        const stopped = typeof controller?.requestStop === 'function'
          ? await controller.requestStop({ reason: 'user_stop' })
          : { ok: true, requested: false, clicked: false };
        return sendJson(res, 200, {
          ok: true,
          tabId,
          requested: !!stopped?.requested || !!active,
          clicked: !!stopped?.clicked,
          activeQuery: activeQueries.get(tabId) || active || null,
          runtime: runtimeSnapshot()
        });
      }

      if (url.pathname === '/read-page' && req.method === 'POST') {
        const body = await parseBody(req);
        const maxChars = positiveIntOr(body.maxChars, 200_000, 1_000_000);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
        const controller = tabs.getControllerById(tabId);
        const text = await runExclusive(controller, async () => controller.readPageText({ maxChars }));
        return sendJson(res, 200, { ok: true, tabId, text });
      }

      if (url.pathname === '/download-images' && req.method === 'POST') {
        const body = await parseBody(req);
        const maxImages = positiveIntOr(body.maxImages, 6, 50);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
        const controller = tabs.getControllerById(tabId);
        const saved = await runExclusive(controller, async () =>
          saveArtifactsForTab({ stateDir, tabs, tabId, controller, mode: 'images', maxImages })
        );
        return sendJson(res, 200, { ok: true, tabId, files: saved.items, dir: saved.dir });
      }

      if (url.pathname === '/artifacts/save' && req.method === 'POST') {
        const body = await parseBody(req);
        const mode = String(body.mode || 'all').trim().toLowerCase();
        const maxImages = positiveIntOr(body.maxImages, 6, 50);
        const maxFiles = positiveIntOr(body.maxFiles, 6, 50);
        const tabId = await resolveTab({
          tabs,
          defaultTabId,
          body,
          url,
          showTabsByDefault: governor.showTabsByDefault,
          createIfMissing: true,
          vendors
        });
        const controller = tabs.getControllerById(tabId);
        const saved = await runExclusive(controller, async () =>
          saveArtifactsForTab({ stateDir, tabs, tabId, controller, mode, maxImages, maxFiles })
        );
        return sendJson(res, 200, { ok: true, tabId, artifacts: saved.items, dir: saved.dir });
      }

      if (url.pathname === '/artifacts/list' && req.method === 'POST') {
        const body = await parseBody(req);
        const limit = positiveIntOr(body.limit, 50, 500);
        const hasScopedTab = !!(
          (body?.tabId ? String(body.tabId).trim() : '') ||
          (body?.key ? String(body.key).trim() : '') ||
          (body?.vendorId ? String(body.vendorId).trim() : '') ||
          (body?.model ? String(body.model).trim() : '') ||
          getTabIdFromUrl(url)
        );
        const tabId = hasScopedTab
          ? await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: false, vendors })
          : null;
        const artifacts = await listArtifacts({ stateDir, tabId, limit });
        return sendJson(res, 200, { ok: true, tabId, artifacts });
      }

      if (url.pathname === '/artifacts/open-folder' && req.method === 'POST') {
        const body = await parseBody(req);
        const hasScopedTab = !!(
          (body?.tabId ? String(body.tabId).trim() : '') ||
          (body?.key ? String(body.key).trim() : '') ||
          (body?.vendorId ? String(body.vendorId).trim() : '') ||
          (body?.model ? String(body.model).trim() : '')
        );
        const tabId = hasScopedTab
          ? await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: false, vendors })
          : null;
        const meta = tabId ? getTabMeta(tabs, tabId) : null;
        const folderPath = tabId
          ? await ensureArtifactsDir({ stateDir, tabId, tabKey: meta?.key || null, vendorId: meta?.vendorId || null })
          : artifactsRoot(stateDir);
        const opened = await onOpenArtifactsFolder?.({ tabId, folderPath });
        if (opened === false) {
          const err = new Error('artifacts_folder_open_failed');
          err.data = { folderPath };
          throw err;
        }
        return sendJson(res, 200, { ok: true, tabId, folderPath });
      }

      if (url.pathname === '/bundles/save' && req.method === 'POST') {
        const body = await parseBody(req);
        const bundle = await saveBundle(stateDir, {
          name: body.name,
          promptPrefix: body.promptPrefix,
          attachments: normalizeAbsolutePathList(body.attachments, { field: 'attachments' }),
          contextPaths: normalizeAbsolutePathList(body.contextPaths, { field: 'contextPaths' })
        });
        return sendJson(res, 200, { ok: true, bundle });
      }

      if (url.pathname === '/bundles/get' && req.method === 'POST') {
        const body = await parseBody(req);
        const bundle = await getBundle(stateDir, body.name);
        if (!bundle) {
          const err = new Error('bundle_not_found');
          err.data = { name: String(body.name || '').trim() };
          throw err;
        }
        return sendJson(res, 200, { ok: true, bundle });
      }

      if (url.pathname === '/bundles/delete' && req.method === 'POST') {
        const body = await parseBody(req);
        const deleted = await deleteBundle(stateDir, body.name);
        return sendJson(res, 200, { ok: true, deleted });
      }

      if (url.pathname === '/watch-folders/open' && req.method === 'POST') {
        const body = await parseBody(req);
        const folders = (await onWatchFoldersList?.()) || [];
        const targetName = String(body.name || 'inbox').trim() || 'inbox';
        const target = folders.find((item) => String(item?.name || '') === targetName) || null;
        if (!target) throw new Error('watch_folder_not_found');
        const folderPath = target?.path || null;
        if (!folderPath) return sendJson(res, 500, { error: 'watch_folder_unavailable' });
        const opened = await onOpenWatchFolder?.({ name: targetName, folderPath });
        if (opened === false) {
          const err = new Error('artifacts_folder_open_failed');
          err.data = { folderPath };
          throw err;
        }
        return sendJson(res, 200, { ok: true, folder: { name: targetName, path: folderPath } });
      }

      if (url.pathname === '/watch-folders/scan' && req.method === 'POST') {
        const result = await onScanWatchFolder?.();
        return sendJson(res, 200, { ok: true, ...(result || {}) });
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const mapped = mapErrorToHttp(error);
      if (mapped) return sendJson(res, mapped.code, mapped.body);
      return sendJson(res, 500, { error: 'internal_error', message: error?.message || String(error), data: error?.data || null });
    }
  });

  server.getRuntimeState = () => runtimeSnapshot();
  server.stopActiveQuery = async ({ tabId }) => {
    const active = patchActiveQuery(tabId, { stopRequested: true, stopRequestedAt: Date.now() }) || null;
    const controller = tabs.getControllerById(tabId);
    const stopped = typeof controller?.requestStop === 'function'
      ? await controller.requestStop({ reason: 'user_stop' })
      : { ok: true, requested: false, clicked: false };
    return {
      ok: true,
      tabId,
      requested: !!stopped?.requested || !!active,
      clicked: !!stopped?.clicked,
      activeQuery: activeQueries.get(tabId) || active || null,
      runtime: runtimeSnapshot()
    };
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
