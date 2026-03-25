import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modifierMask(modifiers = []) {
  let mask = 0;
  for (const modifier of modifiers) {
    const key = String(modifier || '').toLowerCase();
    if (key === 'alt') mask |= 1;
    else if (key === 'control') mask |= 2;
    else if (key === 'meta') mask |= 4;
    else if (key === 'shift') mask |= 8;
  }
  return mask;
}

function keyDescriptor(key) {
  const raw = String(key || '');
  if (/^[a-z]$/i.test(raw)) {
    const upper = raw.toUpperCase();
    return {
      key: upper,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      nativeVirtualKeyCode: upper.charCodeAt(0)
    };
  }

  const known = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  };
  return known[raw] || {
    key: raw,
    code: raw,
    windowsVirtualKeyCode: 0,
    nativeVirtualKeyCode: 0
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pathCandidatesFromEnv() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
}

async function findExecutableInPath(names) {
  for (const dir of pathCandidatesFromEnv()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return null;
}

export async function findChromeExecutable(explicitPath = null) {
  const userPath = String(explicitPath || '').trim();
  if (userPath) {
    if (await pathExists(userPath)) return userPath;
    throw new Error(`chrome_binary_not_found:${userPath}`);
  }

  const platform = process.platform;
  const macCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];
  const winCandidates = [
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData\\Local'), 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Chromium\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe')
  ];

  const absoluteCandidates =
    platform === 'darwin' ? macCandidates : platform === 'win32' ? winCandidates : [];
  for (const candidate of absoluteCandidates) {
    if (await pathExists(candidate)) return candidate;
  }

  const pathNames =
    platform === 'win32'
      ? ['chrome.exe', 'msedge.exe', 'brave.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'];
  const fromPath = await findExecutableInPath(pathNames);
  if (fromPath) return fromPath;
  throw new Error('chrome_binary_not_found');
}

export function defaultChromeUserDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

export function buildChromeLaunchArgs({ debugPort, userDataDir, profileName = null, startUrl = 'about:blank' } = {}) {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-sync',
    startUrl
  ];
  const trimmedProfile = String(profileName || '').trim();
  if (trimmedProfile) args.splice(2, 0, `--profile-directory=${trimmedProfile}`);
  return args;
}

async function readJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`cdp_http_${response.status}`);
  }
  return await response.json();
}

export class ChromeCdpConnection {
  constructor(wsUrl, { wsFactory } = {}) {
    this.wsUrl = wsUrl;
    this.wsFactory = typeof wsFactory === 'function' ? wsFactory : (url) => new WebSocket(url);
    this.ws = null;
    this.connectPromise = null;
    this.connectReject = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.connected = false;
  }

  async connect() {
    if (this.connected && this.ws) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    let syncFailed = false;
    const pendingConnect = new Promise((resolve, reject) => {
      let ws;
      try {
        ws = this.wsFactory(this.wsUrl);
        this.ws = ws;
      } catch (error) {
        syncFailed = true;
        this.connectPromise = null;
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        this.connectReject = null;
        resolve();
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        this.connectReject = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      this.connectReject = settleReject;
      const onOpen = () => {
        if (this.ws !== ws) return;
        this.connected = true;
        settleResolve();
      };
      const onError = (error) => {
        this.connected = false;
        if (this.ws === ws) this.ws = null;
        settleReject(error);
      };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener('message', (event) => this.#handleMessage(event));
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.ws = null;
        this.#rejectPending(new Error('chrome_cdp_disconnected'));
        settleReject(new Error('chrome_cdp_disconnected'));
      });
    });
    this.connectPromise = syncFailed ? null : pendingConnect;
    await pendingConnect;
  }

  async close() {
    this.connectPromise = null;
    if (!this.ws) return;
    const rejectConnect = this.connectReject;
    try {
      this.ws.close();
    } catch {}
    this.ws = null;
    this.connected = false;
    rejectConnect?.(new Error('chrome_cdp_disconnected'));
    this.#rejectPending(new Error('chrome_cdp_disconnected'));
  }

  on(method, handler) {
    const list = this.listeners.get(method) || [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => {
      const next = (this.listeners.get(method) || []).filter((item) => item !== handler);
      if (next.length) this.listeners.set(method, next);
      else this.listeners.delete(method);
    };
  }

  async send(method, params = {}, sessionId = undefined) {
    await this.connect();
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const response = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    return response;
  }

  #handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(String(event.data || '{}'));
    } catch {
      return;
    }

    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const error = new Error(String(msg.error.message || 'cdp_error'));
        error.data = msg.error;
        pending.reject(error);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    const handlers = this.listeners.get(String(msg.method || '')) || [];
    for (const handler of handlers) {
      try {
        handler(msg.params || {}, msg.sessionId || null);
      } catch {}
    }
  }

  #rejectPending(error) {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const item of pending) {
      try {
        item.reject(error);
      } catch {}
    }
  }
}

class ChromeCdpPageAdapter {
  constructor({ client, targetId, sessionId, windowId = null }) {
    this.client = client;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.windowId = windowId;
    this.closed = false;
    this.minimized = false;
  }

  markClosed() {
    this.closed = true;
  }

  isClosed() {
    return this.closed;
  }

  async initialize({ userAgent } = {}) {
    await this.client.send('Page.enable', {}, this.sessionId);
    await this.client.send('Runtime.enable', {}, this.sessionId);
    await this.client.send('DOM.enable', {}, this.sessionId);
    await this.client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `
          try {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          } catch {}
        `
      },
      this.sessionId
    );
    if (userAgent) {
      await this.client.send('Network.setUserAgentOverride', { userAgent }, this.sessionId).catch(() => {});
    }
  }

  async navigate(url) {
    await this.client.send('Page.navigate', { url }, this.sessionId);
  }

  async evaluate(js) {
    const result = await this.client.send(
      'Runtime.evaluate',
      {
        expression: String(js || ''),
        awaitPromise: true,
        returnByValue: true
      },
      this.sessionId
    );
    return result?.result?.value;
  }

  async getUrl() {
    const value = await this.evaluate('location.href');
    return String(value || '');
  }

  async sendKey(key, { modifiers = [] } = {}) {
    const desc = keyDescriptor(key);
    const mask = modifierMask(modifiers);
    await this.client.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        modifiers: mask,
        key: desc.key,
        code: desc.code,
        windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
        nativeVirtualKeyCode: desc.nativeVirtualKeyCode
      },
      this.sessionId
    );
    await this.client.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        modifiers: mask,
        key: desc.key,
        code: desc.code,
        windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
        nativeVirtualKeyCode: desc.nativeVirtualKeyCode
      },
      this.sessionId
    );
  }

  async insertText(text) {
    await this.client.send('Input.insertText', { text: String(text || '') }, this.sessionId);
  }

  async moveMouse(x, y) {
    await this.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, this.sessionId);
  }

  async mouseDown(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount }, this.sessionId);
  }

  async mouseUp(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount }, this.sessionId);
  }

  async setFileInputFiles(files) {
    let lastNodeIds = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const { root } = await this.client.send('DOM.getDocument', { depth: 12, pierce: true }, this.sessionId);
      const q = await this.client.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"]' }, this.sessionId);
      const nodeIds = Array.isArray(q?.nodeIds) ? q.nodeIds : [];
      lastNodeIds = nodeIds;
      if (!nodeIds.length) {
        await sleep(180);
        continue;
      }

      let lastErr = null;
      for (const nodeId of [...nodeIds].reverse()) {
        try {
          await this.client.send('DOM.setFileInputFiles', { nodeId, files }, this.sessionId);
          lastErr = null;
          break;
        } catch (error) {
          lastErr = error;
        }
      }
      if (!lastErr) return;
      await sleep(180);
    }

    const err = new Error('missing_file_input');
    err.data = { selector: 'input[type=file]', found: lastNodeIds.length };
    throw err;
  }

  async bringToFront() {
    await this.client.send('Page.bringToFront', {}, this.sessionId).catch(() => {});
    if (this.windowId != null) {
      await this.client.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      this.minimized = false;
    }
  }

  async minimize() {
    if (this.windowId == null) return false;
    await this.client.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
    this.minimized = true;
    return true;
  }

  isMinimized() {
    return this.minimized;
  }

  async close() {
    if (this.closed) return;
    try {
      await this.client.send('Target.closeTarget', { targetId: this.targetId });
    } catch {}
    this.closed = true;
  }
}

class ChromeCdpPresenter {
  constructor(page) {
    this.page = page;
  }

  isClosed() {
    return this.page.isClosed();
  }

  isMinimized() {
    return this.page.isMinimized();
  }

  restore() {
    return this.page.bringToFront();
  }

  show() {
    return this.page.bringToFront();
  }

  focus() {
    return this.page.bringToFront();
  }

  minimize() {
    return this.page.minimize();
  }

  isVisible() {
    return !this.page.isClosed();
  }

  close() {
    return this.page.close();
  }
}

export class ChromeCdpBrowserBackend {
  constructor({ stateDir, userAgent, onChanged, executablePath = null, debugPort = 9222, profileMode = 'isolated', profileName = 'Default' } = {}) {
    this.stateDir = stateDir;
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : null;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.executablePath = executablePath;
    this.debugPort = Math.floor(Number(debugPort)) || 9222;
    this.profileMode = String(profileMode || '').trim().toLowerCase() === 'existing' ? 'existing' : 'isolated';
    this.profileName = String(profileName || '').trim() || 'Default';
    this.chromeProcess = null;
    this.client = null;
    this.started = false;
    this.tabClosers = new Map();
    this.chromeUserDataDir =
      this.profileMode === 'existing' ? defaultChromeUserDataDir() : path.join(this.stateDir, 'chrome-user-data');
    this.boundTargetDestroyed = null;
  }

  async start() {
    if (this.started && this.client?.connected && this.client?.ws) {
      return this.getState();
    }

    if (this.profileMode === 'isolated') {
      await fs.mkdir(this.chromeUserDataDir, { recursive: true });
    } else if (!(await pathExists(this.chromeUserDataDir))) {
      const err = new Error('existing_chrome_profile_not_found');
      err.data = { userDataDir: this.chromeUserDataDir, profileName: this.profileName };
      throw err;
    }

    let portOccupied = false;
    try {
      await readJson(`http://127.0.0.1:${this.debugPort}/json/version`);
      portOccupied = true;
    } catch {
      portOccupied = false;
    }
    if (portOccupied) {
      const err = new Error('chrome_debug_port_in_use');
      err.data = {
        debugPort: this.debugPort,
        reason: 'refusing_to_attach_to_existing_browser'
      };
      throw err;
    }

    try {
      const executable = await findChromeExecutable(this.executablePath);
      const args = buildChromeLaunchArgs({
        debugPort: this.debugPort,
        userDataDir: this.chromeUserDataDir,
        profileName: this.profileName,
        startUrl: 'about:blank'
      });
      this.chromeProcess = spawn(executable, args, {
        stdio: 'ignore'
      });
      this.chromeProcess.unref?.();

      let version;
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        try {
          version = await readJson(`http://127.0.0.1:${this.debugPort}/json/version`);
          break;
        } catch {
          await sleep(250);
        }
      }
      if (!version) {
        const err = new Error('chrome_cdp_unavailable');
        err.data =
          this.profileMode === 'existing'
            ? {
                profileMode: this.profileMode,
                profileName: this.profileName,
                userDataDir: this.chromeUserDataDir,
                hint: 'close_regular_chrome_and_retry'
              }
            : { profileMode: this.profileMode, userDataDir: this.chromeUserDataDir };
        throw err;
      }

      const wsUrl = String(version?.webSocketDebuggerUrl || '').trim();
      if (!wsUrl) throw new Error('chrome_cdp_missing_ws_url');
      this.client = new ChromeCdpConnection(wsUrl);
      await this.client.connect();
      this.boundTargetDestroyed = this.client.on('Target.targetDestroyed', ({ targetId }) => {
        const closer = this.tabClosers.get(String(targetId || ''));
        if (!closer) return;
        this.tabClosers.delete(String(targetId || ''));
        try {
          closer();
        } catch {}
        this.onChanged?.();
      });
      this.started = true;
      return this.getState();
    } catch (error) {
      try {
        this.boundTargetDestroyed?.();
      } catch {}
      this.boundTargetDestroyed = null;
      try {
        await this.client?.close?.();
      } catch {}
      this.client = null;
      this.started = false;
      if (this.chromeProcess && !this.chromeProcess.killed) {
        try {
          this.chromeProcess.kill('SIGTERM');
        } catch {}
      }
      this.chromeProcess = null;
      throw error;
    }
  }

  getState() {
    return {
      kind: 'chrome-cdp',
      debugPort: this.debugPort,
      userDataDir: this.chromeUserDataDir,
      profileMode: this.profileMode,
      profileName: this.profileName,
      managedProfile: this.profileMode !== 'existing',
      launchedByAgentify: !!this.chromeProcess
    };
  }

  setQuitting() {}

  async createSession({ url, show = false, onClosed } = {}) {
    await this.start();

    let target;
    try {
      target = await this.client.send('Target.createTarget', { url, newWindow: true });
    } catch {
      target = await this.client.send('Target.createTarget', { url, newWindow: true });
    }
    const targetId = String(target?.targetId || '').trim();
    if (!targetId) throw new Error('chrome_cdp_target_create_failed');
    try {
      const attach = await this.client.send('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = String(attach?.sessionId || '').trim();
      if (!sessionId) throw new Error('chrome_cdp_attach_failed');

      let windowId = null;
      try {
        const browserWindow = await this.client.send('Browser.getWindowForTarget', { targetId });
        if (browserWindow && Number.isFinite(browserWindow.windowId)) windowId = browserWindow.windowId;
      } catch {}

      const page = new ChromeCdpPageAdapter({ client: this.client, targetId, sessionId, windowId });
      await page.initialize({ userAgent: this.userAgent });
      if (show) await page.bringToFront().catch(() => {});
      else await page.minimize().catch(() => {});

      this.tabClosers.set(targetId, () => {
        page.markClosed();
        onClosed?.();
      });
      this.onChanged?.();

      return {
        page,
        presenter: new ChromeCdpPresenter(page),
        close: async () => {
          this.tabClosers.delete(targetId);
          try {
            await page.close();
          } catch {}
          onClosed?.();
        },
        isClosed: () => page.isClosed()
      };
    } catch (error) {
      try {
        await this.client.send('Target.closeTarget', { targetId });
      } catch {}
      throw error;
    }
  }

  async dispose() {
    try {
      this.boundTargetDestroyed?.();
    } catch {}
    this.boundTargetDestroyed = null;
    try {
      await this.client?.close?.();
    } catch {}
    this.client = null;

    if (this.chromeProcess && !this.chromeProcess.killed) {
      try {
        this.chromeProcess.kill('SIGTERM');
      } catch {}
    }
    this.chromeProcess = null;
    this.started = false;
    this.tabClosers.clear();
  }
}
