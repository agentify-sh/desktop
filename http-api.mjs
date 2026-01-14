import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { writeToken } from './state.mjs';

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
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
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
  if (msg === 'missing_url') return { code: 400, body: { error: 'missing_url' } };
  if (msg === 'missing_tabId') return { code: 400, body: { error: 'missing_tabId' } };
  if (msg === 'missing_key') return { code: 400, body: { error: 'missing_key' } };
  if (msg === 'tab_not_found') return { code: 404, body: { error: 'tab_not_found' } };
  if (msg === 'tab_closed') return { code: 409, body: { error: 'tab_closed' } };
  if (msg === 'default_tab_protected') return { code: 409, body: { error: 'default_tab_protected' } };
  if (msg === 'max_tabs_reached') return { code: 409, body: { error: 'max_tabs_reached' } };
  return null;
}

function getTabIdFromUrl(url) {
  const tabId = String(url.searchParams.get('tabId') || '').trim();
  return tabId || null;
}

async function resolveTab({ tabs, defaultTabId, body, url }) {
  const tabId = (body?.tabId ? String(body.tabId).trim() : '') || getTabIdFromUrl(url) || null;
  const key = (body?.key ? String(body.key).trim() : '') || null;
  const name = (body?.name ? String(body.name).trim() : '') || null;
  if (tabId) return tabId;
  if (key) return await tabs.ensureTab({ key, name });
  return defaultTabId;
}

export function startHttpApi({
  host = '127.0.0.1',
  port,
  token,
  tabs,
  defaultTabId,
  serverId,
  stateDir,
  onShow,
  onHide,
  onShutdown,
  getStatus
}) {
  const tokenRef = typeof token === 'string' ? { current: token } : token;
  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) return sendJson(res, 403, { error: 'forbidden' });
      if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, serverId: serverId || null });

      if (!authOk(req, tokenRef.current)) return sendJson(res, 401, { error: 'unauthorized' });

      if (url.pathname === '/status' && req.method === 'GET') {
        const tabId = getTabIdFromUrl(url) || defaultTabId;
        const st = await getStatus({ tabId });
        return sendJson(res, 200, st);
      }

      if (url.pathname === '/show' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url });
        await onShow?.({ tabId });
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/hide' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url });
        await onHide?.({ tabId });
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/tabs' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, tabs: tabs.listTabs(), defaultTabId });
      }
      if (url.pathname === '/tabs/create' && req.method === 'POST') {
        const body = await parseBody(req);
        const key = (body.key ? String(body.key).trim() : '') || null;
        const name = (body.name ? String(body.name).trim() : '') || null;
        const tabId = key ? await tabs.ensureTab({ key, name }) : await tabs.createTab({ name, show: false });
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
        const tabId = await resolveTab({ tabs, defaultTabId, body, url });
        const controller = tabs.getControllerById(tabId);
        await controller.navigate(to);
        return sendJson(res, 200, { ok: true, tabId, url: await controller.getUrl() });
      }

      if (url.pathname === '/ensure-ready' && req.method === 'POST') {
        const body = await parseBody(req);
        const timeoutMs = Number(body.timeoutMs || 0) || 10 * 60_000;
        const tabId = await resolveTab({ tabs, defaultTabId, body, url });
        const controller = tabs.getControllerById(tabId);
        const st = await controller.ensureReady({ timeoutMs });
        return sendJson(res, 200, { ok: true, tabId, state: st });
      }

      if (url.pathname === '/query' && req.method === 'POST') {
        const body = await parseBody(req, { maxBytes: 5_000_000 });
        const timeoutMs = Number(body.timeoutMs || 0) || 10 * 60_000;
        const prompt = String(body.prompt || '');
        const attachments = Array.isArray(body.attachments) ? body.attachments.map(String) : [];
        const tabId = await resolveTab({ tabs, defaultTabId, body, url });
        const controller = tabs.getControllerById(tabId);
        const result = await controller.query({ prompt, attachments, timeoutMs });
        return sendJson(res, 200, { ok: true, tabId, result });
      }

      if (url.pathname === '/read-page' && req.method === 'POST') {
        const body = await parseBody(req);
        const maxChars = Number(body.maxChars || 0) || 200_000;
        const tabId = await resolveTab({ tabs, defaultTabId, body, url });
        const controller = tabs.getControllerById(tabId);
        const text = await controller.readPageText({ maxChars });
        return sendJson(res, 200, { ok: true, tabId, text });
      }

      if (url.pathname === '/download-images' && req.method === 'POST') {
        const body = await parseBody(req);
        const maxImages = Number(body.maxImages || 0) || 6;
        const tabId = await resolveTab({ tabs, defaultTabId, body, url });
        const controller = tabs.getControllerById(tabId);
        const files = await controller.downloadLastAssistantImages({ maxImages });
        return sendJson(res, 200, { ok: true, tabId, files });
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const mapped = mapErrorToHttp(error);
      if (mapped) return sendJson(res, mapped.code, mapped.body);
      return sendJson(res, 500, { error: 'internal_error', message: error?.message || String(error), data: error?.data || null });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
