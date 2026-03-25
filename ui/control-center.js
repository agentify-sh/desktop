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

function fmtDuration(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function fmtSource(source) {
  const key = String(source || '').trim().toLowerCase();
  if (key === 'mcp') return 'MCP';
  if (key === 'ui') return 'UI';
  return 'HTTP';
}

function fmtPhase(phase) {
  const key = String(phase || '').trim().toLowerCase();
  if (key === 'resolving_tab') return 'Starting';
  if (key === 'preparing_context') return 'Packing context';
  if (key === 'waiting_for_ready') return 'Checking page';
  if (key === 'uploading_files') return 'Uploading files';
  if (key === 'typing_prompt') return 'Typing prompt';
  if (key === 'sending_prompt') return 'Sending prompt';
  if (key === 'waiting_for_response') return 'Waiting for response';
  if (key === 'awaiting_user') return 'Waiting for you';
  return key ? key.replace(/_/g, ' ') : 'Working';
}

function fmtOutcomeStatus(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'success') return 'Last OK';
  if (key === 'stopped') return 'Last stop';
  if (key === 'blocked') return 'Last blocked';
  if (key === 'error') return 'Last error';
  return 'Last run';
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

function setHidden(id, hidden) {
  el(id).classList.toggle('isHidden', !!hidden);
}

function getBridge() {
  return window?.agentifyDesktop || null;
}
const fallbackVendors = [
  { id: 'chatgpt', name: 'ChatGPT', status: 'supported' },
  { id: 'perplexity', name: 'Perplexity', status: 'supported' },
  { id: 'claude', name: 'Claude', status: 'supported' },
  { id: 'grok', name: 'Grok', status: 'supported' },
  { id: 'aistudio', name: 'Google AI Studio', status: 'supported' },
  { id: 'gemini', name: 'Gemini', status: 'supported' }
];

function hasApi(name) {
  const b = getBridge();
  return typeof b?.[name] === 'function';
}

async function callApi(name, args, { fallback = null, required = false } = {}) {
  const b = getBridge();
  if (typeof b?.[name] !== 'function') {
    if (required) throw new Error(`missing_desktop_api:${name} (open Control Center inside Agentify Desktop, then restart)`);
    return fallback;
  }
  try {
    if (typeof args === 'undefined') return await b[name]();
    return await b[name](args);
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
    stateDir: '',
    browserBackend: 'electron',
    browser: null,
    runtime: { inflightQueries: 0, activeQueries: [], lastOutcomes: [] }
  };
}

function defaultSettings() {
  return {
    browserBackend: 'electron',
    chromeDebugPort: 9222,
    chromeExecutablePath: null,
    chromeProfileMode: 'isolated',
    chromeProfileName: 'Default',
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

function isChromeCdpSelected() {
  return String(el('setBrowserBackend').value || '').trim() === 'chrome-cdp';
}

function syncChromeProfileFields() {
  const hidden = !isChromeCdpSelected();
  setHidden('chromeProfileModeField', hidden);
  setHidden('chromeProfileNameField', hidden);
}

let lastState = defaultState();
let refreshInFlight = null;
let lastRefreshAt = 0;
let hasLiveUpdates = false;

function tabSortWeight(tab, active, outcome) {
  if (active?.blocked) return 0;
  if (active) return 1;
  if (outcome?.status === 'blocked') return 2;
  if (outcome?.status === 'error') return 3;
  if (outcome?.status === 'stopped') return 4;
  if (outcome?.status === 'success') return 5;
  return tab?.protectedTab ? 7 : 6;
}

async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const state = (await callApi('getState', undefined, { fallback: lastState })) || lastState;
    const settings = (await callApi('getSettings', undefined, { fallback: defaultSettings() })) || defaultSettings();
    const watchFoldersData = (await callApi('listWatchFolders', undefined, { fallback: { folders: [] } })) || { folders: [] };
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
    const runtime = lastState.runtime || { inflightQueries: 0, activeQueries: [], lastOutcomes: [] };
    const activeQueries = Array.isArray(runtime.activeQueries) ? runtime.activeQueries : [];
    const lastOutcomes = Array.isArray(runtime.lastOutcomes) ? runtime.lastOutcomes : [];
    const activeByTab = new Map(activeQueries.map((item) => [item.tabId, item]));
    const outcomeByTab = new Map(lastOutcomes.map((item) => [item.tabId, item]));
    const sortedTabs = [...tabs].sort((a, b) => {
      const aActive = activeByTab.get(a.id) || null;
      const bActive = activeByTab.get(b.id) || null;
      const aOutcome = outcomeByTab.get(a.id) || null;
      const bOutcome = outcomeByTab.get(b.id) || null;
      const weightDelta = tabSortWeight(a, aActive, aOutcome) - tabSortWeight(b, bActive, bOutcome);
      if (weightDelta !== 0) return weightDelta;
      return Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0);
    });
    const list = el('tabsList');
    const empty = el('tabsEmpty');
    list.innerHTML = '';
    const nonDefaultTabs = tabs.filter((item) => !item.protectedTab);
    if (!tabs.length) {
      empty.textContent = 'No tabs listed yet. Open the default tab or create a new vendor tab to start working.';
      empty.style.display = 'block';
    } else if (!nonDefaultTabs.length) {
      empty.textContent = 'Only the pinned default tab is open. Create a keyed vendor tab when you want a dedicated workflow or side-by-side run.';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
    }

    for (const t of sortedTabs) {
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
      const active = activeByTab.get(t.id) || null;
      const outcome = outcomeByTab.get(t.id) || null;
      sub.textContent = `${vendorLabel} • ${keyLabel}${used ? ` • used ${used}` : ''}`;
      meta.appendChild(title);
      meta.appendChild(sub);

      const statusRow = document.createElement('div');
      statusRow.className = 'statusRow';
      const addBadge = (label, className = 'dim') => {
        const badge = document.createElement('span');
        badge.className = `badge ${className}`.trim();
        badge.textContent = label;
        statusRow.appendChild(badge);
      };
      if (t.protectedTab) addBadge('Pinned', 'info');
      if (active) {
        addBadge(active.stopRequested ? 'Stopping' : 'Running', active.stopRequested ? 'warn' : 'ok');
        if (active.source) addBadge(fmtSource(active.source), 'info');
        addBadge(fmtPhase(active.phase), active.blocked ? 'warn' : 'dim');
        if (active.blocked) addBadge(active.blockedTitle || 'Needs attention', 'warn');
        if (active.startedAt) addBadge(`Started ${fmtDuration(Date.now() - active.startedAt)} ago`, 'dim');
      } else {
        addBadge('Idle', 'dim');
        if (outcome?.status) addBadge(fmtOutcomeStatus(outcome.status), outcome.status === 'success' ? 'ok' : outcome.status === 'stopped' ? 'info' : 'warn');
        if (outcome?.source) addBadge(fmtSource(outcome.source), 'dim');
      }
      meta.appendChild(statusRow);

      if (active?.promptPreview) {
        const activity = document.createElement('div');
        activity.className = 'sub';
        activity.textContent = `Current job: ${active.promptPreview}`;
        meta.appendChild(activity);
      }
      if (active?.blockedTitle) {
        const blocked = document.createElement('div');
        blocked.className = 'sub';
        blocked.textContent = active.blockedTitle;
        meta.appendChild(blocked);
      } else if (outcome?.detail) {
        const last = document.createElement('div');
        last.className = 'sub';
        last.textContent = `${outcome.label || fmtOutcomeStatus(outcome.status)}: ${outcome.detail}`;
        meta.appendChild(last);
      }

      const controls = document.createElement('div');
      controls.className = 'controls';

      if (active) {
        const btnStop = document.createElement('button');
        btnStop.className = 'btn secondary tabActionBtn';
        btnStop.textContent = active.stopRequested ? 'Stopping…' : 'Stop';
        btnStop.title = 'Break-glass stop for the running query';
        btnStop.setAttribute('aria-label', 'Stop running query');
        btnStop.disabled = !!active.stopRequested;
        btnStop.onclick = async () => {
          try {
            const out = await callApi('stopQuery', { tabId: t.id }, { required: true });
            statusText(out?.requested ? `Stop requested for ${t.name || t.key || t.id}` : `No active query on ${t.name || t.key || t.id}`);
          } catch (e) {
            statusText(`Stop failed: ${e?.message || String(e)}`);
          } finally {
            await refresh();
          }
        };
        controls.appendChild(btnStop);
      }

      const btnShow = document.createElement('button');
      btnShow.className = 'btn secondary tabActionBtn';
      btnShow.textContent = 'Show';
      btnShow.title = 'Show tab';
      btnShow.setAttribute('aria-label', 'Show tab');
      btnShow.onclick = async () => {
        try {
          await callApi('showTab', { tabId: t.id }, { required: true });
        } finally {
          await refresh();
        }
      };

      const btnHide = document.createElement('button');
      btnHide.className = 'btn secondary tabActionBtn';
      btnHide.textContent = 'Hide';
      btnHide.title = 'Hide tab';
      btnHide.setAttribute('aria-label', 'Hide tab');
      btnHide.onclick = async () => {
        try {
          await callApi('hideTab', { tabId: t.id }, { required: true });
        } finally {
          await refresh();
        }
      };

      const btnClose = document.createElement('button');
      btnClose.className = 'btn secondary tabActionBtn destructive';
      btnClose.textContent = t.protectedTab ? 'Pinned' : 'Close';
      btnClose.title = t.protectedTab
        ? 'The default tab stays pinned so Agentify always has a fallback tab.'
        : 'Close tab';
      btnClose.setAttribute('aria-label', t.protectedTab ? 'Pinned tab' : 'Close tab');
      btnClose.disabled = !!t.protectedTab;
      btnClose.onclick = async () => {
        if (t.protectedTab) return;
        try {
          await callApi('closeTab', { tabId: t.id }, { required: true });
        } finally {
          await refresh();
        }
      };

      controls.appendChild(btnShow);
      controls.appendChild(btnHide);
      controls.appendChild(btnClose);

      row.appendChild(meta);
      row.appendChild(controls);
      list.appendChild(row);
    }

    const watchFolders = Array.isArray(watchFoldersData.folders) ? watchFoldersData.folders : [];
    const watchList = el('watchFoldersList');
    const watchEmpty = el('watchFoldersEmpty');
    watchList.innerHTML = '';
    watchEmpty.style.display = watchFolders.length ? 'none' : 'block';
    for (const folder of watchFolders) {
      const row = document.createElement('div');
      row.className = 'tab';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = folder.name || folder.path;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${folder.path}${folder.isDefault ? ' • default' : ''}`;
      meta.appendChild(title);
      meta.appendChild(sub);

      const controls = document.createElement('div');
      controls.className = 'controls';

      const btnOpen = document.createElement('button');
      btnOpen.className = 'btn secondary tabActionBtn';
      btnOpen.textContent = 'Open';
      btnOpen.title = 'Open folder';
      btnOpen.setAttribute('aria-label', 'Open folder');
      btnOpen.onclick = async () => {
        try {
          await callApi('openWatchFolder', { name: folder.name }, { required: true });
          statusText(`Opened watch folder: ${folder.path}`);
        } catch (e) {
          statusText(`Open watch folder failed: ${e?.message || String(e)}`);
        }
      };

      const btnRemove = document.createElement('button');
      btnRemove.className = 'btn secondary tabActionBtn destructive';
      btnRemove.textContent = folder.isDefault ? 'Default' : 'Remove';
      btnRemove.title = 'Remove watch folder';
      btnRemove.setAttribute('aria-label', 'Remove watch folder');
      btnRemove.disabled = !!folder.isDefault;
      btnRemove.onclick = async () => {
        try {
          const out = await callApi('removeWatchFolder', { name: folder.name }, { required: true });
          el('watchFoldersHint').textContent = out?.deleted ? `Removed ${folder.name}.` : `Folder ${folder.name} not found.`;
          await refresh();
        } catch (e) {
          el('watchFoldersHint').textContent = `Remove failed: ${e?.message || String(e)}`;
        }
      };

      controls.appendChild(btnOpen);
      controls.appendChild(btnRemove);
      row.appendChild(meta);
      row.appendChild(controls);
      watchList.appendChild(row);
    }

    lastRefreshAt = Date.now();
    const browserSummary =
      lastState.browserBackend === 'chrome-cdp'
        ? `Chrome CDP${lastState.browser?.profileMode === 'existing' ? ' (existing profile)' : ''}${lastState.browser?.debugPort ? `:${lastState.browser.debugPort}` : ''}`
        : 'Electron';
    const runningSummary = ` • Running: ${activeQueries.length}`;
    const liveSummary = hasLiveUpdates ? 'Live updates on' : 'Polling every 3s';
    const refreshedSummary = lastRefreshAt ? ` • Refreshed ${new Date(lastRefreshAt).toLocaleTimeString()}` : '';
    statusText(`Backend: ${browserSummary} • Tabs: ${tabs.length}${runningSummary} • ${liveSummary}${refreshedSummary} • State: ${lastState.stateDir || ''}`);

  // Settings UI.
    el('setBrowserBackend').value = settings.browserBackend || 'electron';
    el('setChromeProfileMode').value = settings.chromeProfileMode || 'isolated';
    el('setChromeProfileName').value = settings.chromeProfileName || 'Default';
    setNum('setMaxInflight', settings.maxInflightQueries);
    setNum('setQpm', settings.maxQueriesPerMinute);
    setNum('setTabGap', settings.minTabGapMs);
    setNum('setGlobalGap', settings.minGlobalGapMs);
    setChecked('setShowTabsDefault', settings.showTabsByDefault);
    setChecked('setAllowAuthPopups', settings.allowAuthPopups !== false);
    setChecked('setAcknowledge', false);
    el('btnSaveSettings').disabled = true;
    el('settingsHint').textContent = settings.acknowledgedAt ? `Last acknowledged: ${settings.acknowledgedAt}` : 'Not acknowledged yet.';
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function main() {
  if (!getBridge()) {
    statusText('Control Center starting (waiting for desktop bridge)…');
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
  el('btnOpenArtifacts').onclick = async () => {
    try {
      await callApi('openArtifactsDir', undefined, { required: true });
      statusText(`Opened artifacts directory under: ${lastState.stateDir || ''}`);
    } catch (e) {
      statusText(`Artifacts failed: ${e?.message || String(e)}`);
    }
  };
  el('btnOpenWatch').onclick = async () => {
    try {
      const out = await callApi('openWatchFolder', { name: 'inbox' }, { required: true });
      statusText(`Opened watch folder: ${out?.folderPath || ''}`);
    } catch (e) {
      statusText(`Watch folder failed: ${e?.message || String(e)}`);
    }
  };
  el('btnPickWatchFolder').onclick = async () => {
    try {
      const out = await callApi('pickWatchFolder', undefined, { required: true });
      if (out?.path) el('watchFolderPath').value = out.path;
    } catch (e) {
      el('watchFoldersHint').textContent = `Browse failed: ${e?.message || String(e)}`;
    }
  };
  el('btnAddWatchFolder').onclick = async () => {
    const name = String(el('watchFolderName').value || '').trim();
    const folderPath = String(el('watchFolderPath').value || '').trim();
    el('watchFoldersHint').textContent = '';
    try {
      const out = await callApi('addWatchFolder', { name, path: folderPath }, { required: true });
      el('watchFoldersHint').textContent = `Added watch folder ${out?.folder?.name || ''}.`;
      el('watchFolderName').value = '';
      el('watchFolderPath').value = '';
      await refresh();
    } catch (e) {
      el('watchFoldersHint').textContent = `Add failed: ${e?.message || String(e)}`;
    }
  };
  el('btnScanWatchFolders').onclick = async () => {
    try {
      const out = await callApi('scanWatchFolders', undefined, { required: true });
      const ingested = Array.isArray(out?.ingested) ? out.ingested.length : 0;
      el('watchFoldersHint').textContent = ingested ? `Indexed ${ingested} new file(s).` : 'No new files found.';
    } catch (e) {
      el('watchFoldersHint').textContent = `Scan failed: ${e?.message || String(e)}`;
    }
  };
  el('btnShowDefault').onclick = async () => {
    try {
      const st = await callApi('getState', undefined, { fallback: lastState, required: true });
      const target = st?.defaultTabId || lastState.defaultTabId || null;
      if (!target) throw new Error('missing_default_tab');
      await callApi('showTab', { tabId: target }, { required: true });
      statusText(`Default tab opened: ${target}`);
    } catch (e) {
      statusText(`Open default tab failed: ${e?.message || String(e)}`);
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

  el('setBrowserBackend').onchange = () => {
    syncChromeProfileFields();
  };

  const updateSaveEnabled = () => {
    el('btnSaveSettings').disabled = !el('setAcknowledge').checked;
  };
  el('setAcknowledge').onchange = updateSaveEnabled;
  syncChromeProfileFields();

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
          browserBackend: String(el('setBrowserBackend').value || 'electron').trim() || 'electron',
          chromeProfileMode: String(el('setChromeProfileMode').value || 'isolated').trim() || 'isolated',
          chromeProfileName: String(el('setChromeProfileName').value || 'Default').trim() || 'Default',
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
      const backendChanged = String(saved?.browserBackend || 'electron') !== String(lastState.browserBackend || 'electron');
      el('settingsHint').textContent = `Saved.${saved?.acknowledgedAt ? ` ${saved.acknowledgedAt}` : ''}${backendChanged ? ' Restart Agentify Desktop to apply backend changes.' : ''}`;
      setChecked('setAcknowledge', false);
      el('btnSaveSettings').disabled = true;
    } catch (e) {
      el('settingsHint').textContent = `Save failed: ${e?.message || String(e)}`;
    }
  };

  if (hasApi('onTabsChanged')) {
    try {
      const b = getBridge();
      hasLiveUpdates = true;
      b?.onTabsChanged?.(() => refresh().catch(() => {}));
    } catch (e) {
      hasLiveUpdates = false;
      statusText(`Tabs listener unavailable: ${e?.message || String(e)}`);
      setInterval(() => refresh().catch(() => {}), 3000);
    }
  } else {
    hasLiveUpdates = false;
    statusText('Tabs listener unavailable (compat mode). Auto-refresh every 3s.');
    setInterval(() => refresh().catch(() => {}), 3000);
  }

  await refresh();
}

main().catch((e) => {
  const st = el('statusLine');
  st.textContent = `Control Center error: ${e?.message || String(e)}`;
});
