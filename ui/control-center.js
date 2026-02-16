/* global window */

function el(id) {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing_element:${id}`);
  return n;
}

function fmtTime(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleString();
  } catch {
    return '';
  }
}

function num(id, fallback) {
  const v = Number(el(id).value);
  return Number.isFinite(v) ? v : fallback;
}

function setNum(id, value) {
  el(id).value = String(Number(value));
}

function setChecked(id, value) {
  el(id).checked = !!value;
}

function uuidv4() {
  // RFC4122 v4, from crypto.getRandomValues (browser-safe).
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const bridge = window?.agentifyDesktop || {};
const fallbackVendors = [
  { id: 'chatgpt', name: 'ChatGPT', status: 'supported' },
  { id: 'perplexity', name: 'Perplexity', status: 'supported' },
  { id: 'claude', name: 'Claude', status: 'supported' },
  { id: 'grok', name: 'Grok', status: 'supported' },
  { id: 'aistudio', name: 'Google AI Studio', status: 'supported' },
  { id: 'gemini', name: 'Gemini', status: 'supported' }
];

function hasApi(name) {
  return typeof bridge?.[name] === 'function';
}

async function callApi(name, args, { fallback = null, required = false } = {}) {
  if (!hasApi(name)) {
    if (required) throw new Error(`missing_desktop_api:${name}`);
    return fallback;
  }
  try {
    if (typeof args === 'undefined') return await bridge[name]();
    return await bridge[name](args);
  } catch (e) {
    if (required) throw e;
    return fallback;
  }
}

function defaultState() {
  return {
    ok: false,
    vendors: [...fallbackVendors],
    tabs: [],
    defaultTabId: null,
    stateDir: ''
  };
}

function defaultSettings() {
  return {
    maxInflightQueries: 2,
    maxQueriesPerMinute: 12,
    minTabGapMs: 0,
    minGlobalGapMs: 0,
    showTabsByDefault: false,
    allowAuthPopups: true,
    acknowledgedAt: null
  };
}

function statusText(msg) {
  el('statusLine').textContent = msg;
}

let lastState = defaultState();
let refreshInFlight = null;

async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const state = (await callApi('getState', undefined, { fallback: lastState })) || lastState;
    const settings = (await callApi('getSettings', undefined, { fallback: defaultSettings() })) || defaultSettings();
    const orch = (await callApi('getOrchestrators', undefined, { fallback: { running: [], recent: [] } })) || { running: [], recent: [] };
    lastState = { ...defaultState(), ...state };

    const vendorSelect = el('vendorSelect');
    const prev = String(vendorSelect.value || '').trim();
    vendorSelect.innerHTML = '';
    const vendors = Array.isArray(lastState.vendors) && lastState.vendors.length ? lastState.vendors : fallbackVendors;
    for (const v of vendors) {
    const opt = document.createElement('option');
      opt.value = String(v.id || '').trim();
    opt.textContent = `${v.name}${v.status && v.status !== 'supported' ? ` (${v.status})` : ''}`;
      if (prev && prev === opt.value) opt.selected = true;
      else if (!prev && v.id === 'chatgpt') opt.selected = true;
    vendorSelect.appendChild(opt);
  }
    if (!vendorSelect.value && vendorSelect.options.length > 0) {
      vendorSelect.value = vendorSelect.options[0].value;
    }

    const tabs = Array.isArray(lastState.tabs) ? lastState.tabs : [];
    const list = el('tabsList');
    const empty = el('tabsEmpty');
    list.innerHTML = '';
    empty.style.display = tabs.length ? 'none' : 'block';

    for (const t of tabs) {
    const row = document.createElement('div');
    row.className = 'tab';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = t.name || t.key || t.id;

    const sub = document.createElement('div');
    sub.className = 'sub';
    const vendorLabel = t.vendorName ? `${t.vendorName}` : 'Unknown vendor';
    const keyLabel = t.key ? `key=${t.key}` : 'no key';
    const used = t.lastUsedAt ? fmtTime(t.lastUsedAt) : '';
    sub.textContent = `${vendorLabel} • ${keyLabel}${used ? ` • used ${used}` : ''}`;

    meta.appendChild(title);
    meta.appendChild(sub);

    const controls = document.createElement('div');
    controls.className = 'controls';

    const btnShow = document.createElement('button');
    btnShow.className = 'btn secondary';
    btnShow.textContent = 'Show';
    btnShow.onclick = async () => {
        try {
          await callApi('showTab', { tabId: t.id }, { required: true });
        } finally {
          await refresh();
        }
    };

    const btnHide = document.createElement('button');
    btnHide.className = 'btn secondary';
    btnHide.textContent = 'Hide';
    btnHide.onclick = async () => {
        try {
          await callApi('hideTab', { tabId: t.id }, { required: true });
        } finally {
          await refresh();
        }
    };

    const btnClose = document.createElement('button');
    btnClose.className = 'btn secondary';
    btnClose.textContent = 'Close';
    btnClose.onclick = async () => {
      if (t.protectedTab) return;
        try {
          await callApi('closeTab', { tabId: t.id }, { required: true });
        } finally {
          await refresh();
        }
    };

    if (t.protectedTab) btnClose.disabled = true;
    controls.appendChild(btnShow);
    controls.appendChild(btnHide);
    controls.appendChild(btnClose);

    row.appendChild(meta);
    row.appendChild(controls);
    list.appendChild(row);
  }

    statusText(`Tabs: ${tabs.length} • State: ${lastState.stateDir || ''}`);

  // Settings UI.
    setNum('setMaxInflight', settings.maxInflightQueries);
    setNum('setQpm', settings.maxQueriesPerMinute);
    setNum('setTabGap', settings.minTabGapMs);
    setNum('setGlobalGap', settings.minGlobalGapMs);
    setChecked('setShowTabsDefault', settings.showTabsByDefault);
    setChecked('setAllowAuthPopups', settings.allowAuthPopups !== false);
    setChecked('setAcknowledge', false);
    el('btnSaveSettings').disabled = true;
    el('settingsHint').textContent = settings.acknowledgedAt ? `Last acknowledged: ${settings.acknowledgedAt}` : 'Not acknowledged yet.';

  // Orchestrator status.
    const running = Array.isArray(orch?.running) ? orch.running : [];
    const recent = Array.isArray(orch?.recent) ? orch.recent : [];
    const orchStatus =
      running.length === 0
        ? 'No orchestrators running.'
        : `Running: ${running.map((r) => `${r.key} (pid ${r.pid})`).join(', ')}`;
    el('orchStatus').textContent = orchStatus;
    if (running.length === 1 && running[0].logPath) el('orchWorkspaceHint').textContent = `Log: ${running[0].logPath}`;
    else if (recent.length) {
      el('orchWorkspaceHint').textContent = `Last exit: ${recent[0].key} code=${recent[0].exitCode ?? 'null'} signal=${recent[0].signal || 'null'}`;
    } else {
      el('orchWorkspaceHint').textContent = '';
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function main() {
  if (!window?.agentifyDesktop) {
    throw new Error('desktop_bridge_unavailable');
  }

  el('btnRefresh').onclick = () => refresh().catch((e) => statusText(`Refresh failed: ${e?.message || String(e)}`));
  el('btnOpenState').onclick = async () => {
    try {
      await callApi('openStateDir', undefined, { required: true });
      statusText(`Opened state directory: ${lastState.stateDir || ''}`);
    } catch (e) {
      statusText(`State failed: ${e?.message || String(e)}`);
    }
  };
  el('btnShowDefault').onclick = async () => {
    try {
      const st = await callApi('getState', undefined, { fallback: lastState, required: true });
      const target = st?.defaultTabId || lastState.defaultTabId || null;
      if (!target) throw new Error('missing_default_tab');
      await callApi('showTab', { tabId: target }, { required: true });
      statusText(`Default tab shown: ${target}`);
    } catch (e) {
      statusText(`Show default failed: ${e?.message || String(e)}`);
    }
  };

  el('btnCreate').onclick = async () => {
    const vendorId = String(el('vendorSelect').value || '').trim() || 'chatgpt';
    const key = String(el('tabKey').value || '').trim() || null;
    const name = String(el('tabName').value || '').trim() || null;
    const show = !!el('tabShow').checked;
    el('createHint').textContent = '';
    try {
      const out = await callApi('createTab', { vendorId, key, name, show }, { required: true });
      el('createHint').textContent = `Created tab ${out.tabId || ''}`;
      await refresh();
    } catch (e) {
      el('createHint').textContent = `Create failed: ${e?.message || String(e)}`;
    }
  };

  const orchRefresh = async () => {
    await refresh();
  };
  el('btnOrchRefresh').onclick = () => orchRefresh().catch(() => {});

  el('btnOrchStart').onclick = async () => {
    const key = String(el('orchKey').value || '').trim();
    const workspace = String(el('orchWorkspace').value || '').trim();
    if (!key) {
      el('orchStatus').textContent = 'Enter a project key.';
      return;
    }
    try {
      if (workspace) await callApi('setWorkspaceForKey', { key, workspace }, { required: true });
      await callApi('startOrchestrator', { key }, { required: true });
      await orchRefresh();
    } catch (e) {
      el('orchStatus').textContent = `Start failed: ${e?.message || String(e)}`;
    }
  };

  el('btnOrchStop').onclick = async () => {
    const key = String(el('orchKey').value || '').trim();
    if (!key) {
      el('orchStatus').textContent = 'Enter a project key.';
      return;
    }
    try {
      await callApi('stopOrchestrator', { key }, { required: true });
      await orchRefresh();
    } catch (e) {
      el('orchStatus').textContent = `Stop failed: ${e?.message || String(e)}`;
    }
  };

  el('btnOrchStopAll').onclick = async () => {
    try {
      await callApi('stopAllOrchestrators', undefined, { required: true });
      await orchRefresh();
    } catch (e) {
      el('orchStatus').textContent = `Stop all failed: ${e?.message || String(e)}`;
    }
  };

  el('btnOrchCopy').onclick = async () => {
    const key = String(el('orchKey').value || '').trim();
    if (!key) {
      el('orchStatus').textContent = 'Enter a project key first.';
      return;
    }
    const tool = String(el('orchTool').value || 'codex.run').trim();
    const obj =
      tool === 'codex.run'
        ? { agentify_tool: tool, id: uuidv4(), key, mode: 'interactive', args: { prompt: 'Describe the task for Codex here.' } }
        : tool === 'fs.read'
          ? { agentify_tool: tool, id: uuidv4(), key, mode: 'batch', args: { path: 'relative/path/to/file.txt', maxBytes: 50000 } }
          : { agentify_tool: tool, id: uuidv4(), key, mode: 'batch', args: {} };
    const text = `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
    try {
      await navigator.clipboard.writeText(text);
      el('orchStatus').textContent = 'Copied tool JSON to clipboard. Paste it into the ChatGPT thread.';
    } catch {
      el('orchStatus').textContent = 'Copy failed. Your browser may block clipboard access; select and copy manually: ' + text;
    }
  };

  el('orchKey').onchange = async () => {
    const key = String(el('orchKey').value || '').trim();
    if (!key) return;
    try {
      const ws = await callApi('getWorkspaceForKey', { key }, { required: true });
      const root = ws?.workspace?.root || '';
      if (root) {
        el('orchWorkspace').value = root;
        el('orchWorkspaceHint').textContent = `Saved workspace: ${root}`;
      } else {
        el('orchWorkspaceHint').textContent = 'No saved workspace for this key yet.';
      }
    } catch {}
  };

  const updateSaveEnabled = () => {
    el('btnSaveSettings').disabled = !el('setAcknowledge').checked;
  };
  el('setAcknowledge').onchange = updateSaveEnabled;

  el('btnResetSettings').onclick = async () => {
    el('settingsHint').textContent = '';
    try {
      await callApi('setSettings', { reset: true }, { required: true });
      el('settingsHint').textContent = 'Reset to defaults.';
      await refresh();
    } catch (e) {
      el('settingsHint').textContent = `Reset failed: ${e?.message || String(e)}`;
    }
  };

  el('btnSaveSettings').onclick = async () => {
    if (!el('setAcknowledge').checked) return;
    el('settingsHint').textContent = '';
    try {
      const saved = await callApi(
        'setSettings',
        {
        maxInflightQueries: num('setMaxInflight', 2),
        maxQueriesPerMinute: num('setQpm', 12),
        minTabGapMs: num('setTabGap', 0),
        minGlobalGapMs: num('setGlobalGap', 0),
        showTabsByDefault: !!el('setShowTabsDefault').checked,
        allowAuthPopups: !!el('setAllowAuthPopups').checked,
          acknowledge: true
        },
        { required: true }
      );
      el('settingsHint').textContent = `Saved.${saved?.acknowledgedAt ? ` ${saved.acknowledgedAt}` : ''}`;
      setChecked('setAcknowledge', false);
      el('btnSaveSettings').disabled = true;
    } catch (e) {
      el('settingsHint').textContent = `Save failed: ${e?.message || String(e)}`;
    }
  };

  if (hasApi('onTabsChanged')) {
    try {
      bridge.onTabsChanged(() => refresh().catch(() => {}));
    } catch (e) {
      statusText(`Tabs listener unavailable: ${e?.message || String(e)}`);
      setInterval(() => refresh().catch(() => {}), 3000);
    }
  } else {
    statusText('Tabs listener unavailable (compat mode). Auto-refresh every 3s.');
    setInterval(() => refresh().catch(() => {}), 3000);
  }

  const hasOrch =
    hasApi('getOrchestrators') &&
    hasApi('startOrchestrator') &&
    hasApi('stopOrchestrator') &&
    hasApi('stopAllOrchestrators');
  if (!hasOrch) {
    for (const id of ['btnOrchStart', 'btnOrchStop', 'btnOrchStopAll', 'btnOrchRefresh', 'btnOrchCopy', 'orchKey', 'orchWorkspace', 'orchTool']) {
      try {
        el(id).disabled = true;
      } catch {}
    }
    el('orchStatus').textContent = 'Orchestrator controls unavailable in this build.';
  }

  await refresh();
}

main().catch((e) => {
  const st = el('statusLine');
  st.textContent = `Control Center error: ${e?.message || String(e)}`;
});
