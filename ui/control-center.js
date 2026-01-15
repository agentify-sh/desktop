async function refresh() {
  const tabs = await window.agentify.tabsList();
  const cfg = await window.agentify.configGet();
  renderTabs(tabs);
  renderCfg(cfg);
}

function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing_element:${id}`);
  return node;
}

function renderTabs(data) {
  const body = el('tabsBody');
  body.innerHTML = '';
  const rows = Array.isArray(data?.tabs) ? data.tabs : [];
  for (const t of rows) {
    const tr = document.createElement('tr');
    const tdKey = document.createElement('td');
    tdKey.textContent = t.key || '';
    const tdName = document.createElement('td');
    tdName.textContent = t.name || '';
    const tdId = document.createElement('td');
    tdId.className = 'mono';
    tdId.textContent = t.id || '';
    const tdActions = document.createElement('td');
    const btnShow = document.createElement('button');
    btnShow.textContent = 'Show';
    btnShow.onclick = async () => {
      await window.agentify.tabShow(t.id);
      await refresh();
    };
    const btnHide = document.createElement('button');
    btnHide.textContent = 'Hide';
    btnHide.onclick = async () => {
      await window.agentify.tabHide(t.id);
      await refresh();
    };
    const btnClose = document.createElement('button');
    btnClose.textContent = 'Close';
    btnClose.className = 'danger';
    btnClose.onclick = async () => {
      await window.agentify.tabClose(t.id);
      await refresh();
    };
    tdActions.appendChild(btnShow);
    tdActions.appendChild(document.createTextNode(' '));
    tdActions.appendChild(btnHide);
    tdActions.appendChild(document.createTextNode(' '));
    tdActions.appendChild(btnClose);

    tr.appendChild(tdKey);
    tr.appendChild(tdName);
    tr.appendChild(tdId);
    tr.appendChild(tdActions);
    body.appendChild(tr);
  }
}

function renderCfg(cfg) {
  el('cfgShowTabs').checked = !!cfg.showTabsByDefault;
  el('cfgMaxTabs').value = String(cfg.maxTabs ?? '');
  el('cfgMaxParallelQueries').value = String(cfg.maxParallelQueries ?? '');
  el('cfgMinQueryGapMs').value = String(cfg.minQueryGapMs ?? '');
  el('cfgMinQueryGapMsGlobal').value = String(cfg.minQueryGapMsGlobal ?? '');
  el('cfgQueryGapMaxWaitMs').value = String(cfg.queryGapMaxWaitMs ?? '');
}

function readCfgFromForm() {
  return {
    showTabsByDefault: el('cfgShowTabs').checked,
    maxTabs: Number(el('cfgMaxTabs').value),
    maxParallelQueries: Number(el('cfgMaxParallelQueries').value),
    minQueryGapMs: Number(el('cfgMinQueryGapMs').value),
    minQueryGapMsGlobal: Number(el('cfgMinQueryGapMsGlobal').value),
    queryGapMaxWaitMs: Number(el('cfgQueryGapMaxWaitMs').value)
  };
}

async function main() {
  el('btnRefresh').onclick = refresh;
  el('btnCreate').onclick = async () => {
    const key = el('newKey').value.trim();
    const name = el('newName').value.trim() || null;
    const show = el('newShow').checked;
    if (!key) return;
    await window.agentify.tabCreate({ key, name, show });
    await refresh();
  };

  el('btnSaveCfg').onclick = async () => {
    const msg = el('cfgMsg');
    msg.textContent = '';
    try {
      const next = readCfgFromForm();
      const saved = await window.agentify.configSet(next);
      msg.textContent = 'Saved. Some settings require restart to apply.';
      renderCfg(saved);
    } catch (e) {
      msg.textContent = `Save failed: ${e?.message || String(e)}`;
    }
  };
  el('btnOpenState').onclick = async () => {
    await window.agentify.openStateDir();
  };
  el('btnRestartHint').onclick = async () => {
    const msg = el('cfgMsg');
    msg.textContent = 'To apply maxTabs/showTabs defaults, restart the desktop app (or use agentify_shutdown then run start again).';
  };

  await refresh();
}

main().catch((e) => {
  const msg = document.createElement('div');
  msg.className = 'card';
  msg.textContent = `Control Center failed: ${e?.message || String(e)}`;
  document.body.appendChild(msg);
});

