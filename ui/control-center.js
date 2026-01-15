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

async function refresh() {
  const state = await window.agentifyDesktop.getState();
  const settings = await window.agentifyDesktop.getSettings();
  const orch = await window.agentifyDesktop.getOrchestrators();

  const vendorSelect = el('vendorSelect');
  vendorSelect.innerHTML = '';
  for (const v of state.vendors || []) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `${v.name}${v.status && v.status !== 'supported' ? ` (${v.status})` : ''}`;
    if (v.id === 'chatgpt') opt.selected = true;
    vendorSelect.appendChild(opt);
  }

  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
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
      await window.agentifyDesktop.showTab({ tabId: t.id });
    };

    const btnHide = document.createElement('button');
    btnHide.className = 'btn secondary';
    btnHide.textContent = 'Hide';
    btnHide.onclick = async () => {
      await window.agentifyDesktop.hideTab({ tabId: t.id });
    };

    const btnClose = document.createElement('button');
    btnClose.className = 'btn secondary';
    btnClose.textContent = 'Close';
    btnClose.onclick = async () => {
      if (t.protectedTab) return;
      await window.agentifyDesktop.closeTab({ tabId: t.id });
    };

    if (t.protectedTab) btnClose.disabled = true;
    controls.appendChild(btnShow);
    controls.appendChild(btnHide);
    controls.appendChild(btnClose);

    row.appendChild(meta);
    row.appendChild(controls);
    list.appendChild(row);
  }

  el('statusLine').textContent = `Tabs: ${tabs.length} • State: ${state.stateDir || ''}`;

  // Settings UI.
  setNum('setMaxInflight', settings.maxInflightQueries);
  setNum('setQpm', settings.maxQueriesPerMinute);
  setNum('setTabGap', settings.minTabGapMs);
  setNum('setGlobalGap', settings.minGlobalGapMs);
  setChecked('setShowTabsDefault', settings.showTabsByDefault);
  setChecked('setAcknowledge', false);
  el('btnSaveSettings').disabled = true;
  el('settingsHint').textContent = settings.acknowledgedAt ? `Last acknowledged: ${settings.acknowledgedAt}` : 'Not acknowledged yet.';

  // Orchestrator status.
  const running = Array.isArray(orch?.running) ? orch.running : [];
  const statusLine =
    running.length === 0
      ? 'No orchestrators running.'
      : `Running: ${running.map((r) => `${r.key} (pid ${r.pid})`).join(', ')}`;
  el('orchStatus').textContent = statusLine;
  el('orchWorkspaceHint').textContent = '';
}

async function main() {
  el('btnRefresh').onclick = refresh;
  el('btnOpenState').onclick = async () => {
    await window.agentifyDesktop.openStateDir();
  };
  el('btnShowDefault').onclick = async () => {
    const st = await window.agentifyDesktop.getState();
    if (st.defaultTabId) await window.agentifyDesktop.showTab({ tabId: st.defaultTabId });
  };

  el('btnCreate').onclick = async () => {
    const vendorId = String(el('vendorSelect').value || '').trim();
    const key = String(el('tabKey').value || '').trim() || null;
    const name = String(el('tabName').value || '').trim() || null;
    const show = !!el('tabShow').checked;
    el('createHint').textContent = '';
    try {
      const out = await window.agentifyDesktop.createTab({ vendorId, key, name, show });
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
      if (workspace) await window.agentifyDesktop.setWorkspaceForKey({ key, workspace });
      await window.agentifyDesktop.startOrchestrator({ key });
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
      await window.agentifyDesktop.stopOrchestrator({ key });
      await orchRefresh();
    } catch (e) {
      el('orchStatus').textContent = `Stop failed: ${e?.message || String(e)}`;
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
      const ws = await window.agentifyDesktop.getWorkspaceForKey({ key });
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
      await window.agentifyDesktop.setSettings({ reset: true });
      el('settingsHint').textContent = 'Reset to defaults.';
      await refresh();
    } catch (e) {
      el('settingsHint').textContent = `Reset failed: ${e?.message || String(e)}`;
    }
  };

  el('btnSaveSettings').onclick = async () => {
    el('settingsHint').textContent = '';
    try {
      const payload = {
        maxInflightQueries: num('setMaxInflight', 2),
        maxQueriesPerMinute: num('setQpm', 12),
        minTabGapMs: num('setTabGap', 1200),
        minGlobalGapMs: num('setGlobalGap', 200),
        showTabsByDefault: !!el('setShowTabsDefault').checked,
        acknowledge: !!el('setAcknowledge').checked
      };
      const out = await window.agentifyDesktop.setSettings(payload);
      el('settingsHint').textContent = `Saved. Acknowledged: ${out.acknowledgedAt || 'no'}`;
      await refresh();
    } catch (e) {
      el('settingsHint').textContent = `Save failed: ${e?.message || String(e)}`;
    }
  };

  window.agentifyDesktop.onTabsChanged(() => {
    refresh().catch(() => {});
  });

  await refresh();
}

main().catch((e) => {
  el('statusLine').textContent = `Error: ${e?.message || String(e)}`;
});
