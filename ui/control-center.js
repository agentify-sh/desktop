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

async function refresh() {
  const state = await window.agentifyDesktop.getState();

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

  window.agentifyDesktop.onTabsChanged(() => {
    refresh().catch(() => {});
  });

  await refresh();
}

main().catch((e) => {
  el('statusLine').textContent = `Error: ${e?.message || String(e)}`;
});
