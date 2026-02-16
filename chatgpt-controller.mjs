import fs from 'node:fs/promises';
import path from 'node:path';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || 0);
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function sleepWithJitter(ms, j = 40) {
  await sleep(ms + jitter(0, j));
}

class Mutex {
  #p = Promise.resolve();
  async run(fn) {
    const start = this.#p;
    let release;
    this.#p = new Promise((r) => (release = r));
    await start;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class ChatGPTController {
  constructor({ webContents, loadURL, selectors, onBlocked, onUnblocked, stateDir }) {
    this.webContents = webContents;
    this.loadURL = loadURL;
    this.selectors = selectors;
    this.onBlocked = onBlocked;
    this.onUnblocked = onUnblocked;
    this.stateDir = stateDir;
    this.mutex = new Mutex();
    this.blocked = false;
    this.blockedKind = null;
    this.serverId = null;
    this.mouse = { x: 30, y: 30 };
  }

  async runExclusive(fn) {
    return await this.mutex.run(fn);
  }

  async navigate(url) {
    await this.loadURL(url);
  }

  async #eval(js) {
    return await this.webContents.executeJavaScript(js, true);
  }

  async getUrl() {
    return this.webContents.getURL();
  }

  async readPageText({ maxChars = 200_000 } = {}) {
    const text = await this.#eval(`(() => {
      const el = document.querySelector('main') || document.body;
      return (el?.innerText || document.body?.innerText || '').slice(0, ${maxChars});
    })()`);
    return String(text || '');
  }

  async detectChallenge() {
    const result = await this.#eval(`(() => {
      const url = location.href || '';
      const title = document.title || '';
      const readyState = document.readyState || '';
      const bodyText = (document.body?.innerText || '').slice(0, 5000);
      const iframeSrcs = Array.from(document.querySelectorAll('iframe'))
        .map(f => String(f.getAttribute('src') || ''))
        .filter(Boolean);

      const hasTurnstile = iframeSrcs.some(s => /turnstile/i.test(s)) || !!document.querySelector('iframe[src*=\"turnstile\" i]');
      const hasArkose = iframeSrcs.some(s => /arkoselabs|arkose/i.test(s)) || !!document.querySelector('iframe[src*=\"arkose\" i], iframe[src*=\"arkoselabs\" i]');
      const hasVerifyButton = Array.from(document.querySelectorAll('button, a'))
        .some(b => /verify you are human|human verification|i am human/i.test((b.textContent || '').trim()));

      const looks403 = /\\b403\\b|access denied|forbidden|unusual traffic|verify/i.test(bodyText) && !/prompt/i.test(bodyText);
      const loginLike = !!document.querySelector('input[type=\"password\"], input[name=\"password\"], input[autocomplete=\"current-password\"]')
        || /log in|sign in|continue with/i.test(bodyText);

      const promptVisible = (() => {
        const candidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const el = candidates.find((n) => {
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          if (!visible) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.isContentEditable) return true;
          return true;
        });
        return !!el;
      })();

      const blocked = hasTurnstile || hasArkose || hasVerifyButton || looks403 || (loginLike && !promptVisible);
      const kind = (hasTurnstile || hasArkose || hasVerifyButton) ? 'captcha' : (loginLike ? 'login' : (looks403 ? 'blocked' : null));
      return {
        url, title, readyState,
        blocked,
        promptVisible,
        kind,
        indicators: { hasTurnstile, hasArkose, hasVerifyButton, looks403, loginLike }
      };
    })()`);

    return result;
  }

  async waitForPromptVisible({ timeoutMs = 10 * 60_000, pollMs = 500 } = {}) {
    const start = Date.now();
    let activeElapsed = 0;
    let lastTick = Date.now();
    while (activeElapsed < timeoutMs) {
      const now = Date.now();
      const delta = now - lastTick;
      lastTick = now;
      if (!this.blocked) activeElapsed += delta;

      const st = await this.detectChallenge().catch(() => null);
      if (st?.blocked) await this.#enterBlockedState(st);
      if (st?.promptVisible) return st;

      const elapsed = Date.now() - start;
      if (!this.blocked && elapsed > 5000 && st?.readyState === 'complete') {
        await this.#enterBlockedState({ ...(st || {}), blocked: true, kind: 'ui' });
      }
      await sleep(pollMs);
    }
    const last = await this.detectChallenge().catch(() => null);
    const err = new Error('timeout_waiting_for_prompt');
    err.data = last;
    throw err;
  }

  async ensureReady({ timeoutMs = 10 * 60_000 } = {}) {
    const st = await this.detectChallenge().catch(() => null);
    if (st?.blocked) {
      await this.#enterBlockedState(st);
    }
    const ready = await this.waitForPromptVisible({ timeoutMs });
    await this.#exitBlockedStateIfNeeded();
    return ready;
  }

  async #enterBlockedState(st) {
    if (!this.blocked) {
      this.blocked = true;
      this.blockedKind = st?.kind || null;
      await this.onBlocked?.(st);
    }
  }

  async #exitBlockedStateIfNeeded() {
    if (this.blocked) {
      this.blocked = false;
      this.blockedKind = null;
      await this.onUnblocked?.();
    }
  }

  async #sendKey(key, { modifiers = [] } = {}) {
    const wc = this.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    // Only send a char event for printable single-character keys.
    const hasCommandModifier = Array.isArray(modifiers) && modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt');
    if (typeof key === 'string' && key.length === 1 && !hasCommandModifier) {
      wc.sendInputEvent({ type: 'char', keyCode: key, modifiers });
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
  }

  async #typeHuman(text) {
    const wc = this.webContents;
    for (const ch of String(text)) {
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      await sleep(jitter(12, 45));
    }
  }

  async #moveMouseTo(x, y) {
    const wc = this.webContents;
    const from = { ...this.mouse };
    const steps = Math.max(6, Math.min(22, Math.floor(Math.hypot(x - from.x, y - from.y) / 35)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = Math.round(from.x + (x - from.x) * t + jitter(-2, 2));
      const ny = Math.round(from.y + (y - from.y) * t + jitter(-2, 2));
      wc.sendInputEvent({ type: 'mouseMove', x: nx, y: ny, movementX: 0, movementY: 0 });
      await sleep(jitter(6, 18));
      this.mouse = { x: nx, y: ny };
    }
  }

  async #clickAt(x, y) {
    const wc = this.webContents;
    await this.#moveMouseTo(x, y);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(jitter(20, 60));
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  async #typePrompt(prompt) {
    const sel = JSON.stringify(this.selectors.promptTextarea);
    const ok = await this.#eval(`(() => {
      const candidates = Array.from(document.querySelectorAll(${sel}));
      const el = candidates.find((n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        if (!visible) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.isContentEditable) return true;
        return true;
      }) || candidates[0];
      if (!el) return { ok:false, error:'missing_prompt_textarea' };
      el.focus();
      const r = el.getBoundingClientRect();
      return { ok:true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    })()`);
    if (!ok?.ok) {
      const err = new Error(ok?.error || 'type_failed');
      err.data = ok;
      throw err;
    }

    // Human-like click + select-all + type.
    if (ok?.rect?.w > 0 && ok?.rect?.h > 0) {
      const cx = Math.round(ok.rect.x + Math.min(ok.rect.w - 6, 18));
      const cy = Math.round(ok.rect.y + Math.min(ok.rect.h - 6, 18));
      await this.#clickAt(cx, cy);
    }

    const isMac = process.platform === 'darwin';
    await sleep(jitter(25, 80));
    await this.#sendKey('A', { modifiers: [isMac ? 'meta' : 'control'] });
    await sleep(jitter(15, 50));
    await this.#sendKey('Backspace');
    await sleep(jitter(25, 80));
    await this.#typeHuman(prompt);
  }

  async #clickSend() {
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const res = await this.#eval(`(() => {
      const stop = Array.from(document.querySelectorAll(${stopSel})).find((n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      if (stop) return { ok:false, error:'already_generating' };
      const btn = Array.from(document.querySelectorAll(${sendSel})).find((n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        if (!(r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none')) return false;
        return !n.disabled;
      });
      if (!btn) return { ok:false, error:'missing_send_button' };
      if (btn.disabled) return { ok:false, error:'send_button_disabled' };
      const r = btn.getBoundingClientRect();
      return { ok:true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    })()`);
    if (!res?.ok) {
      const err = new Error(res?.error || 'send_failed');
      err.data = res;
      throw err;
    }

    if (res?.rect?.w > 0 && res?.rect?.h > 0) {
      const cx = Math.round(res.rect.x + res.rect.w / 2);
      const cy = Math.round(res.rect.y + res.rect.h / 2);
      await this.#clickAt(cx, cy);
      return;
    }

    // Fallback
    await this.#eval(`(() => { const btn = document.querySelector(${sendSel}); if (btn) btn.click(); })()`);
  }

  async #attachFiles(files) {
    if (!files?.length) return;
    const absFiles = files.map((p) => path.resolve(p));
    for (const f of absFiles) await fs.access(f);

    // Best-effort: click the paperclip/attach UI, then set <input type=file> via DevTools protocol.
    await this.#eval(`(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role=\"button\"]'));
      const attach = candidates.find(b => /attach|upload|paperclip/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||'')));
      if (attach) attach.click();
      return true;
    })()`);

    const wc = this.webContents;
    const didAttach = !wc.debugger.isAttached();
    try {
      if (didAttach) wc.debugger.attach('1.3');
    } catch {
      // If debugger attach fails, we can't reliably set file input.
      const err = new Error('file_upload_unavailable');
      err.data = { reason: 'debugger_attach_failed' };
      throw err;
    }

    try {
      let lastNodeIds = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: 12, pierce: true });
        const q = await wc.debugger.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"]' });
        const nodeIds = Array.isArray(q?.nodeIds) ? q.nodeIds : [];
        lastNodeIds = nodeIds;
        if (!nodeIds.length) {
          await sleepWithJitter(180);
          continue;
        }

        let lastErr = null;
        // Prefer last input (often the real one appended to the DOM).
        const tryIds = [...nodeIds].reverse();
        for (const nodeId of tryIds) {
          try {
            await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: absFiles });
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!lastErr) return;
        await sleepWithJitter(180);
      }

      const err = new Error('missing_file_input');
      err.data = { selector: 'input[type=file]', found: lastNodeIds.length };
      throw err;
    } finally {
      try {
        if (didAttach && wc.debugger.isAttached()) wc.debugger.detach();
      } catch {}
    }
  }

  async #waitForAssistantStable({ timeoutMs = 5 * 60_000, stableMs = 1500, pollMs = 400 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const start = Date.now();
    let last = '';
    let lastChange = Date.now();
    let stopGoneAt = null;
    let continueClicks = 0;

    while (Date.now() - start < timeoutMs) {
      const snap = await this.#eval(`(() => {
        const stop = !!document.querySelector(${stopSel});
        const send = document.querySelector(${sendSel});
        const sendEnabled = !!send && !send.disabled;
        const nodes = Array.from(document.querySelectorAll(${assistantSel}));
        const lastNode = nodes[nodes.length - 1];
        const txt = (lastNode?.innerText || '').trim();
        const hasContinue = Array.from(document.querySelectorAll('button, a')).some(b => /continue generating/i.test((b.textContent||'').trim()));
        const hasRegenerate = Array.from(document.querySelectorAll('button, a')).some(b => /regenerate/i.test((b.textContent||'').trim()));
        const hasError = /something went wrong|try again|error/i.test(txt) && txt.length < 500;
        return { stop, sendEnabled, txt, count: nodes.length, hasError, hasContinue, hasRegenerate };
      })()`);

      const txt = String(snap?.txt || '');
      if (txt !== last) {
        last = txt;
        lastChange = Date.now();
      }

      if (snap?.stop) stopGoneAt = null;
      else if (stopGoneAt == null) stopGoneAt = Date.now();

      const dynamicStableMs = Math.max(stableMs, txt.length > 8000 ? 3000 : txt.length > 2000 ? 2200 : stableMs);
      const stable = Date.now() - lastChange >= dynamicStableMs;
      const stopGoneLongEnough = stopGoneAt != null && Date.now() - stopGoneAt >= 800;

      if (!snap?.stop && snap?.hasContinue && continueClicks < 3) {
        continueClicks += 1;
        await this.#eval(`(() => {
          const btn = Array.from(document.querySelectorAll('button, a')).find(b => /continue generating/i.test((b.textContent||'').trim()));
          if (btn) btn.click();
        })()`);
        await sleep(250);
        continue;
      }

      const done = !snap?.stop && stopGoneLongEnough && snap?.sendEnabled && stable && txt.length > 0;
      if (done) {
        const extra = await this.#eval(`(() => {
          const nodes = Array.from(document.querySelectorAll(${assistantSel}));
          const lastNode = nodes[nodes.length - 1];
          const codes = Array.from(lastNode?.querySelectorAll('pre code') || []).map(c => {
            const cls = String(c.className || '');
            const lang = (cls.match(/language-([a-z0-9_-]+)/i) || [])[1] || null;
            return { language: lang, text: (c.innerText || '').trim() };
          }).filter(c => c.text);
          return { codeBlocks: codes };
        })()`);
        return { text: txt, codeBlocks: extra?.codeBlocks || [], meta: { count: snap?.count || 0, hasError: !!snap?.hasError } };
      }

      await sleep(pollMs);
    }

    const err = new Error('timeout_waiting_for_response');
    err.data = { last };
    throw err;
  }

  async query({ prompt, attachments = [], timeoutMs = 10 * 60_000 } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');

    await this.ensureReady({ timeoutMs });
    await this.#attachFiles(attachments);
    await this.#typePrompt(prompt);
    await this.#clickSend();
    return await this.#waitForAssistantStable({ timeoutMs: Math.min(timeoutMs, 8 * 60_000) });
  }

  async send({ text, timeoutMs = 3 * 60_000, stopAfterSend = false } = {}) {
    const prompt = String(text || '');
    if (!prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');

    return await this.mutex.run(async () => {
      await this.ensureReady({ timeoutMs });
      await this.#typePrompt(prompt);
      await this.#clickSend();

      if (stopAfterSend) {
        const stopSel = JSON.stringify(this.selectors.stopButton);
        const start = Date.now();
        while (Date.now() - start < 2500) {
          const clicked = await this.#eval(`(() => {
            const stop = document.querySelector(${stopSel});
            if (!stop) return false;
            try { stop.click(); return true; } catch { return false; }
          })()`);
          if (clicked) break;
          await sleep(120);
        }
      }

      return { ok: true };
    });
  }

  async getLastAssistantImages({ maxImages = 6 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const out = await this.#eval(`(async () => {
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const last = nodes[nodes.length - 1];
      if (!last) return [];
      const imgs = Array.from(last.querySelectorAll('img'));
      const canvases = Array.from(last.querySelectorAll('canvas'));
      const results = [];
      for (const img of imgs.slice(0, ${maxImages})) {
        const src = img.currentSrc || img.src || '';
        const alt = img.alt || '';
        if (!src) continue;
        if (src.startsWith('blob:') || src.startsWith('https://') || src.startsWith('http://')) {
          try {
            const r = await fetch(src);
            const b = await r.blob();
            if (b.size > 15 * 1024 * 1024) { results.push({ src, alt }); continue; }
            const dataUrl = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onerror = () => reject(new Error('file_reader_error'));
              fr.onload = () => resolve(String(fr.result || ''));
              fr.readAsDataURL(b);
            });
            results.push({ src, alt, dataUrl });
            continue;
          } catch {}
        }
        results.push({ src, alt });
      }

      for (let i = 0; i < canvases.length && results.length < ${maxImages}; i++) {
        const c = canvases[i];
        try {
          const dataUrl = c.toDataURL('image/png');
          if (dataUrl && dataUrl.startsWith('data:image/')) {
            results.push({ src: 'canvas:' + (i + 1), alt: 'canvas', dataUrl });
          }
        } catch {}
      }

      // Background-image urls (rare but possible)
      if (results.length < ${maxImages}) {
        const bgEls = Array.from(last.querySelectorAll('*')).filter(el => {
          const s = getComputedStyle(el);
          return s && s.backgroundImage && s.backgroundImage.includes('url(');
        }).slice(0, 50);
        for (const el of bgEls) {
          if (results.length >= ${maxImages}) break;
          const s = getComputedStyle(el).backgroundImage || '';
          const m = s.match(/url\\([\"']?([^\"')]+)[\"']?\\)/i);
          const src = m?.[1] || '';
          if (src && (src.startsWith('http://') || src.startsWith('https://'))) results.push({ src, alt: 'background-image' });
        }
      }
      return results;
    })()`);
    return Array.isArray(out) ? out : [];
  }

  async downloadLastAssistantImages({ maxImages = 6 } = {}) {
    const imgs = await this.getLastAssistantImages({ maxImages });
    const outDir = path.join(this.stateDir, 'downloads');
    await fs.mkdir(outDir, { recursive: true });
    const saved = [];

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      let dataUrl = img.dataUrl || null;
      let mime = null;
      let buf = null;

      if (dataUrl && /^data:/i.test(dataUrl)) {
        const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
        if (m) {
          mime = m[1];
          buf = Buffer.from(m[2], 'base64');
        }
      }

      if (!buf && img.src && /^https?:\/\//i.test(img.src)) {
        const r = await fetch(img.src);
        if (!r.ok) continue;
        mime = r.headers.get('content-type') || 'application/octet-stream';
        buf = Buffer.from(await r.arrayBuffer());
      }

      if (!buf) continue;

      const ext =
        mime?.includes('png') ? 'png' : mime?.includes('jpeg') || mime?.includes('jpg') ? 'jpg' : mime?.includes('webp') ? 'webp' : 'bin';
      const name = `chatgpt-${Date.now()}-${String(i + 1).padStart(2, '0')}.${ext}`;
      const file = path.join(outDir, name);
      await fs.writeFile(file, buf);
      saved.push({ path: file, alt: img.alt || '', mime: mime || null, source: img.src || null });
    }

    return saved;
  }
}
