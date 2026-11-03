// Org Launcher page: one dense table. All data goes into the DOM through textContent (el() below), never as HTML.
(() => {
  'use strict';

  const TYPES = { scratch: 'scratch', sandbox: 'sandbox', devhub: 'Dev Hub', production: 'production', developer: 'developer', org: 'org' };
  const COLUMNS = [
    ['name', 'Name', true, 'col-name'], ['type', 'Type', true, 'col-type'], ['tags', 'Tags', true, 'col-tags'],
    ['packages', 'Packages', true, 'col-pkgs'], ['expires', 'Expires', true, 'col-exp'], ['note', 'Note', false, 'col-note'],
    ['actions', '⋯', false, 'actions'],
  ];
  const MAX_TAB_TAGS = 6;
  const BROWSERS = [['chrome', 'Chrome'], ['edge', 'Edge'], ['brave', 'Brave'], ['firefox', 'Firefox']];
  // The same rules the server checks; here only to say what's wrong sooner. The server has the last word.
  const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
  const CHROMIUM_PROFILE = /^(Default|Profile [0-9]{1,4})$/;
  const FIREFOX_PROFILE = /^[A-Za-z0-9_.][A-Za-z0-9 ._-]{0,63}$/;
  const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

  let data = null;
  let tab = 'all';       // 'all' or a tag
  let sort = 'name';
  let query = '';
  let showHidden = false;
  let editing = null;    // { id, field: 'note' | 'tag' } while an inline editor is open
  let selId = null;      // keyboard selection
  let pollTimer = null;
  const expanded = new Set();  // org ids whose package list is open

  try {
    tab = localStorage.getItem('orgLauncher.tab') || 'all';
    sort = localStorage.getItem('orgLauncher.sort') || 'name';
  } catch (e) { /* storage blocked */ }
  if (!COLUMNS.some(([k, , s]) => k === sort && s)) sort = 'name';
  const remember = (k, v) => { try { localStorage.setItem(`orgLauncher.${k}`, v); } catch (e) { /* ignore */ } };

  // --- tiny DOM helper -------------------------------------------------------------------------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }
  const $ = (id) => document.getElementById(id);
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

  // --- server calls ------------------------------------------------------------------------------
  async function api(path, body) {
    const opts = body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    const r = await fetch(path, opts);
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `Request failed (${r.status}).`);
    return out;
  }

  let loadFailed = false;  // the last load failed; its message was shown once

  async function load() {
    try {
      data = await api('/api/orgs');
      loadFailed = false;
      render();
    } catch (e) {
      if (!loadFailed) toast(`Couldn't load the list: ${e.message}`);
      loadFailed = true;
    }
    // A failed poll during a refresh tries again, so the list still updates when the refresh ends.
    schedulePoll();
  }

  async function refresh() {
    try {
      await api('/api/refresh', {});
      await load();
    } catch (e) {
      toast(e.message);
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (data && data.refresh && data.refresh.running) pollTimer = setTimeout(load, 3000);
  }

  async function update(id, fields) {
    try {
      await api('/api/org', { id, ...fields });
      await load();
    } catch (e) {
      toast(e.message);
      render();
    }
  }

  async function openOrg(id, username, button) {
    if (button) button.disabled = true;
    try {
      await api('/api/open', username ? { id, username } : { id });
    } catch (e) {
      toast(e.message);
    } finally {
      if (button) setTimeout(() => { button.disabled = false; }, 1500);
    }
  }

  async function removeOrg(org) {
    const msg = org.type === 'scratch' && org.health !== 'expired'
      ? `Forget the login for ${org.alias}? This is a scratch org: once its login is gone you can't log back in, so you lose it.`
      : `Forget the login for ${org.alias} on this computer? The org itself is not deleted.`;
    if (!confirm(msg)) return;
    try {
      await api('/api/remove', { id: org.id });
      await load();
    } catch (e) {
      toast(e.message);
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  // --- cell content ------------------------------------------------------------------------------
  const pkgText = (p) => `${p.name} ${p.version}`;

  function sourceText(source) {
    return ['src', `${source.apexClasses} Apex`, source.project].filter(Boolean).join(' · ');
  }

  function failedMark(org) {
    if (!org.checkFailed) return null;
    const when = org.checkedAt ? ` (${new Date(org.checkedAt).toLocaleString()})` : '';
    return el('span', { class: 'red warn', title: `The last check didn't work${when}, so this may be out of date.` }, '⚠');
  }

  function packagesCell(org) {
    if (org.packages === null) {
      return org.health === 'expired' ? el('span', { class: 'muted' }, '—') : el('span', { class: 'muted', title: 'Not checked yet' }, '…');
    }
    const parts = [failedMark(org)];
    if (org.source) parts.push(el('span', { class: 'mono amber', title: 'Apex deployed from source, outside any package' }, sourceText(org.source)));
    const pkgs = org.packages;
    if (pkgs.length > 0 && pkgs.length <= 2) {
      parts.push(...pkgs.map((p) => el('span', { class: 'mono pkg', title: p.namespace ? `Namespace ${p.namespace}` : null }, pkgText(p))));
    } else if (pkgs.length > 2) {
      const open = expanded.has(org.id);
      parts.push(el('button', {
        class: 'pkg-toggle', type: 'button', 'aria-expanded': String(open),
        onclick: (e) => { e.stopPropagation(); if (open) expanded.delete(org.id); else expanded.add(org.id); render(); },
      }, `${pkgs.length} packages ${open ? '▾' : '▸'}`));
      if (open) parts.push(...pkgs.map((p) => el('span', { class: 'mono pkg' }, pkgText(p))));
    }
    if (!org.source && pkgs.length === 0) parts.push(el('span', { class: 'muted' }, '—'));
    return parts;
  }

  // The whole list, for a cell cut short on a narrow window.
  function packagesTitle(org) {
    const lines = [org.source ? sourceText(org.source) : '', ...(org.packages || []).map(pkgText)].filter(Boolean);
    return lines.length ? lines.join('\n') : null;
  }

  function expiresCell(org) {
    if (org.health === 'expired') return el('span', { class: 'red', title: org.expires ? `Expired ${org.expires}` : null }, 'expired');
    if (org.health === 'unreachable') {
      return [el('span', { class: 'red', title: org.healthReason || '' }, "can't reach"),
        org.healthReason ? el('span', { class: 'reason', title: org.healthReason }, org.healthReason) : null];
    }
    // The org answered, so it isn't dead: only the main login lacks permission.
    if (org.health === 'limited') {
      return [el('span', { class: 'amber', title: org.healthReason || '' }, 'limited access'),
        org.healthReason ? el('span', { class: 'reason', title: org.healthReason }, org.healthReason) : null];
    }
    const d = org.daysLeft;
    if (org.type !== 'scratch' || d === null || d === undefined) return el('span', { class: 'muted' }, '—');
    const text = d < 0 ? 'expired' : d === 0 ? 'today' : `${d}d`;
    return el('span', { class: d <= 3 ? 'mono red' : 'mono', title: `Expires ${org.expires}` }, text);
  }

  // An inline text editor. Enter saves, Esc cancels; blur saves or cancels as the caller says.
  function inlineEditor(attrs, onSave, saveOnBlur) {
    const input = el('input', { class: 'inline-edit', ...attrs });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      editing = null;
      // onSave returns true when it saves (and so re-renders). Deferred: blur can fire while render() is removing this input.
      if (!save || !onSave(input.value)) setTimeout(render, 0);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(saveOnBlur));
    input.addEventListener('click', (e) => e.stopPropagation());
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return input;
  }

  function startEdit(id, field) {
    editing = { id, field };
    render();
  }
  const isEditing = (org, field) => editing && editing.id === org.id && editing.field === field;

  function noteView(org) {
    if (isEditing(org, 'note')) {
      return inlineEditor({ value: org.note, maxlength: '500', 'aria-label': `Note for ${org.alias}` }, (value) => {
        if (value.trim() === org.note) return false;
        update(org.id, { note: value });
        return true;
      }, true);
    }
    const edit = (e) => { e.stopPropagation(); startEdit(org.id, 'note'); };
    return org.note
      ? el('span', { class: 'note', title: org.note, onclick: edit }, org.note)
      : el('span', { class: 'note placeholder', onclick: edit }, '+ note');
  }

  function tagsCell(org) {
    const chips = org.tags.map((t) => el('span', { class: tab === t ? 'chip on' : 'chip' },
      el('button', { class: 'chip-name', type: 'button', title: `Show orgs tagged ${t}`,
        onclick: (e) => { e.stopPropagation(); setTab(tab === t ? 'all' : t); } }, t),
      el('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove tag ${t}`, title: `Remove tag ${t}`,
        onclick: (e) => { e.stopPropagation(); update(org.id, { removeTags: [t] }); } }, '×')));
    if (isEditing(org, 'tag')) {
      chips.push(inlineEditor({ class: 'inline-edit tag-input', maxlength: '32', placeholder: 'tag', 'aria-label': `New tag for ${org.alias}` },
        (value) => {
          const tag = value.trim().toLowerCase();
          if (!tag) return false;
          if (!TAG.test(tag)) { toast('Tags are lowercase letters, numbers, dot, dash or underscore, up to 32 characters.'); return false; }
          update(org.id, { addTags: [tag] });
          return true;
        }, false));
    } else {
      chips.push(el('button', { class: 'chip-add', type: 'button', title: 'Add a tag', 'aria-label': `Add a tag to ${org.alias}`,
        onclick: (e) => { e.stopPropagation(); startEdit(org.id, 'tag'); } }, '+'));
    }
    return el('span', { class: 'chips' }, chips);
  }

  // --- the ⋯ menu --------------------------------------------------------------------------------
  let openMenu = null;
  let renderWaiting = false;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    if (renderWaiting) { renderWaiting = false; render(); }
  }
  document.addEventListener('click', (e) => {
    if (openMenu && !openMenu.contains(e.target)) closeMenu();
  });

  function menuButton(rowOrg) {
    const wrap = el('span', { class: 'menu-wrap' });
    const btn = el('button', { class: 'more', type: 'button', 'aria-label': `More for ${rowOrg.alias}`, title: 'More' }, '⋯');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // ⋯ on the row whose menu is open just closes it.
      const wasOpenHere = openMenu !== null && wrap.contains(openMenu);
      closeMenu();
      if (wasOpenHere) return;
      // closeMenu() may have run a waiting render that rebuilt the rows, so attach to the row on the page now.
      const liveWrap = [...document.querySelectorAll('#rows tr[data-id]')]
        .find((tr) => tr.dataset.id === rowOrg.id)?.querySelector('.menu-wrap');
      if (!liveWrap) return;
      const org = data.orgs.find((o) => o.id === rowOrg.id) || rowOrg;
      const items = [];
      const others = org.logins.filter((l) => !l.main);
      for (const login of others) {
        items.push(el('button', { type: 'button', title: login.username, onclick: () => openOrg(org.id, login.username) },
          `Open as ${login.username}`));
      }
      for (const login of others) {
        items.push(el('button', { type: 'button', title: login.username, onclick: () => update(org.id, { mainLogin: login.username }) },
          `Make ${login.username} the main login`));
      }
      if (items.length) items.push(el('hr'));
      items.push(el('button', { type: 'button', onclick: () => openInDialog(org) }, 'Open in…'));
      items.push(el('button', { type: 'button', onclick: () => update(org.id, { hidden: !org.hidden }) },
        org.hidden ? 'Unhide' : 'Hide'));
      items.push(el('hr'));
      items.push(el('button', { type: 'button', class: 'danger', onclick: () => removeOrg(org) }, 'Remove login from this computer…'));
      openMenu = el('div', { class: 'menu', role: 'menu', onclick: () => setTimeout(closeMenu, 0) }, items);
      liveWrap.append(openMenu);
    });
    wrap.append(btn);
    return wrap;
  }

  // --- dialogs -----------------------------------------------------------------------------------
  let openDialog = null;

  // A browser picker and a profile box. read() gives an open target, null for "none", or throws a message.
  function targetFields(target, noneLabel) {
    const select = el('select', { 'aria-label': 'Browser' },
      el('option', { value: '' }, noneLabel),
      BROWSERS.map(([v, label]) => el('option', { value: v }, label)));
    select.value = target ? target.browser : '';
    const profile = el('input', { type: 'text', class: 'profile', placeholder: 'profile (optional)', maxlength: '64',
      'aria-label': 'Profile', value: target && target.profile ? target.profile : '' });
    const sync = () => { profile.disabled = select.value === ''; };
    select.addEventListener('change', sync);
    sync();
    const read = () => {
      const browser = select.value;
      if (!browser) return null;
      const name = profile.value.trim();
      if (!name) return { browser };
      const ok = browser === 'firefox' ? FIREFOX_PROFILE.test(name) : CHROMIUM_PROFILE.test(name);
      if (!ok) {
        throw new Error(browser === 'firefox'
          ? "Firefox profile names are letters, numbers, spaces, dot, dash or underscore, and can't start with a dash or a space."
          : 'Profiles for this browser are named "Default" or "Profile" and a number, like "Profile 3".');
      }
      return { browser, profile: name };
    };
    return { select, profile, read };
  }

  function profileHelp() {
    return IS_MAC
      ? el('p', { class: 'help' }, 'Find the profile folder at chrome://version → Profile Path (the last part, like Profile 3).')
      : null;
  }

  // A modal dialog. save() returns a promise; a thrown message shows in the dialog and keeps it open.
  function showDialog(title, body, save) {
    const error = el('p', { class: 'dialog-error', role: 'alert', hidden: true });
    const saveBtn = el('button', { type: 'submit', class: 'open' }, 'Save');
    const cancel = el('button', { type: 'button', class: 'mini' }, 'Cancel');
    const form = el('form', { method: 'dialog' }, el('h2', {}, title), body, error, el('div', { class: 'dialog-buttons' }, cancel, saveBtn));
    const dialog = el('dialog', { class: 'dialog' }, form);
    const close = () => {
      if (!dialog.open) return;
      dialog.close();
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      openDialog = null;
      render();
    });
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      saveBtn.disabled = true;
      try {
        await save();
        close();
        await load();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        saveBtn.disabled = false;
      }
    });
    openDialog = dialog;
    document.body.append(dialog);
    dialog.showModal();
  }

  function openInDialog(org) {
    const fields = targetFields(org.open, 'Use the tag or default choice');
    showDialog(`Open ${org.alias} in…`, [
      el('p', { class: 'help' }, 'Pick a browser and profile for this org only. It wins over tag and default choices.'),
      el('div', { class: 'target-row' }, fields.select, fields.profile),
      profileHelp(),
    ], async () => {
      const target = fields.read();
      await api('/api/org', { id: org.id, open: target });
    });
  }

  function settingsDialog() {
    const settings = (data && data.settings) || { defaultOpen: null, tagOpen: {} };
    const def = targetFields(settings.defaultOpen, 'System default browser');
    const list = el('div', { class: 'tag-rules' });
    const rules = [];
    const addRule = (tag, target) => {
      const tagInput = el('input', { type: 'text', class: 'tag-input', placeholder: 'tag', maxlength: '32', 'aria-label': 'Tag', value: tag });
      const fields = targetFields(target || { browser: 'chrome' }, 'Choose a browser');
      const rule = { tagInput, fields };
      const row = el('div', { class: 'target-row' }, tagInput, fields.select, fields.profile,
        el('button', { type: 'button', class: 'mini', 'aria-label': 'Remove this tag rule',
          onclick: () => { rules.splice(rules.indexOf(rule), 1); row.remove(); } }, '×'));
      rules.push(rule);
      list.append(row);
    };
    for (const [tag, target] of Object.entries(settings.tagOpen || {})) addRule(tag, target);
    showDialog('Settings', [
      el('h3', {}, 'Open orgs in'),
      el('div', { class: 'target-row' }, def.select, def.profile),
      el('h3', {}, 'By tag'),
      el('p', { class: 'help' }, "An org with one of these tags opens here, unless the org has its own choice."),
      list,
      el('button', { type: 'button', class: 'link', onclick: () => addRule('', null) }, '+ add a tag'),
      profileHelp(),
    ], async () => {
      const tagOpen = {};
      for (const { tagInput, fields } of rules) {
        const tag = tagInput.value.trim().toLowerCase();
        if (!tag) continue;
        if (!TAG.test(tag)) throw new Error(`"${tag}" isn't a tag. Tags are lowercase letters, numbers, dot, dash or underscore.`);
        const target = fields.read();
        if (!target) throw new Error(`Choose a browser for ${tag}.`);
        tagOpen[tag] = target;
      }
      await api('/api/settings', { defaultOpen: def.read(), tagOpen });
    });
  }

  // --- rows --------------------------------------------------------------------------------------
  const isDead = (org) => org.health === 'expired' || org.health === 'unreachable';

  function nameTitle(org) {
    return [
      org.logins.find((l) => l.main)?.username,
      org.otherAliases.length ? `Also: ${org.otherAliases.join(', ')}` : '',
      org.devHub ? `Dev Hub: ${org.devHub}` : '',
    ].filter(Boolean).join('\n');
  }

  function row(org) {
    const action = org.health === 'expired'
      ? el('button', { class: 'open danger', type: 'button', onclick: (e) => { e.stopPropagation(); removeOrg(org); } }, 'Remove')
      : el('button', { class: 'open', type: 'button', onclick: (e) => { e.stopPropagation(); openOrg(org.id, null, e.currentTarget); } }, 'Open');
    const cls = [isDead(org) ? 'dead' : '', org.id === selId ? 'sel' : ''].filter(Boolean).join(' ') || null;
    return el('tr', { class: cls, 'data-id': org.id, onclick: () => { selId = org.id; markSel(); } },
      el('td', { class: 'col-name' }, el('span', { class: 'name', title: nameTitle(org) }, org.alias)),
      el('td', { class: 'type col-type' }, TYPES[org.type] || org.type),
      el('td', { class: 'col-tags' }, tagsCell(org)),
      el('td', { class: expanded.has(org.id) ? 'col-pkgs open-list' : 'col-pkgs', title: packagesTitle(org) }, packagesCell(org)),
      el('td', { class: 'col-exp' }, expiresCell(org)),
      el('td', { class: 'col-note' }, noteView(org)),
      el('td', { class: 'actions' }, action, menuButton(org)));
  }

  // --- filtering, sorting, keyboard --------------------------------------------------------------
  function matches(org) {
    if (!query) return true;
    const hay = [org.alias, org.note, ...org.otherAliases, ...org.tags,
      ...org.logins.flatMap((l) => [l.username, ...l.aliases]),
      ...(org.packages || []).map((p) => p.name), org.source && org.source.project]
      .filter(Boolean).join(' ').toLowerCase();
    return query.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }

  const byName = (a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: 'base' });
  const pkgSortText = (o) => [o.source ? 'src' : '', ...(o.packages || []).map(pkgText)].join(' ');
  const SORTS = {
    name: byName,
    type: (a, b) => (TYPES[a.type] || a.type).localeCompare(TYPES[b.type] || b.type) || byName(a, b),
    tags: (a, b) => (a.tags[0] || '~').localeCompare(b.tags[0] || '~') || byName(a, b),
    packages: (a, b) => pkgSortText(b).localeCompare(pkgSortText(a), undefined, { numeric: true }) || byName(a, b),
    expires: (a, b) => (a.daysLeft ?? 1e6) - (b.daysLeft ?? 1e6) || byName(a, b),
  };

  function visibleRows() {
    if (!data) return [];
    const dead = (o) => (isDead(o) ? 1 : 0);
    return data.orgs
      .filter((o) => !o.hidden && (tab === 'all' || o.tags.includes(tab)) && matches(o))
      .sort((a, b) => dead(a) - dead(b) || SORTS[sort](a, b));
  }

  function setTab(t) {
    tab = t;
    remember('tab', t);
    selId = null;
    render();
  }

  function markSel() {
    for (const tr of document.querySelectorAll('#rows tr[data-id]')) {
      tr.classList.toggle('sel', tr.dataset.id === selId);
      if (tr.dataset.id === selId) tr.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveSel(step) {
    const ids = visibleRows().map((o) => o.id);
    if (!ids.length) return;
    const i = ids.indexOf(selId);
    selId = ids[i < 0 ? (step > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + step))];
    markSel();
  }

  function openSelected() {
    const rows = visibleRows();
    const org = rows.find((o) => o.id === selId) || rows[0];
    if (!org) return;
    if (org.health === 'expired') { toast(`${org.alias} has expired.`); return; }
    const button = document.querySelector(`#rows tr[data-id="${org.id}"] .open`);
    openOrg(org.id, null, button);
  }

  document.addEventListener('keydown', (e) => {
    if (openDialog) return;
    if (e.key === 'Escape') {
      if (openMenu) { closeMenu(); return; }
      if (document.activeElement === $('search') && query) { query = ''; $('search').value = ''; render(); }
      return;
    }
    const inSearch = document.activeElement === $('search');
    const typing = !inSearch && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing) return;
    if (e.key === '/' && !inSearch) { e.preventDefault(); $('search').focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); return; }
    if (e.key === 'Enter' && (inSearch || selId)) { e.preventDefault(); openSelected(); }
  });

  // --- page --------------------------------------------------------------------------------------
  function tabCounts(visible) {
    const counts = new Map();
    for (const o of visible) for (const t of o.tags) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  }

  function emptyText(r) {
    if (data.orgs.length === 0) {
      return r.running ? 'Loading…' : 'No orgs yet. Log in to one with sf org login web, then refresh.';
    }
    if (query) return 'Nothing matches.';
    return 'Nothing here.';
  }

  function render() {
    if (!data) return;
    // Background polls must not throw away a note or tag being typed, an open menu or a dialog.
    if (editing && document.activeElement && document.activeElement.classList.contains('inline-edit')) return;
    if (openMenu) { renderWaiting = true; return; }
    if (openDialog) return;

    const orgs = data.orgs;
    const visible = orgs.filter((o) => !o.hidden);
    const r = data.refresh || {};

    // A tag that's gone from every org falls back to All (not while the list is still loading).
    if (tab !== 'all' && orgs.length > 0 && !orgs.some((o) => o.tags.includes(tab))) tab = 'all';
    const tabs = $('tabs');
    clear(tabs);
    const counted = tabCounts(visible);
    const shown = counted.slice(0, MAX_TAB_TAGS);
    if (tab !== 'all' && !shown.some(([t]) => t === tab)) shown.push([tab, (counted.find(([t]) => t === tab) || [tab, 0])[1]]);
    for (const [k, n] of [['all', visible.length], ...shown]) {
      tabs.append(el('button', { class: 'tab', type: 'button', 'aria-pressed': String(tab === k), onclick: () => setTab(k) },
        k === 'all' ? 'All' : k, el('span', { class: 'n' }, n)));
    }

    const at = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('status').textContent = r.running
      ? (r.total ? `checking ${r.done || 0}/${r.total}` : 'listing orgs…')
      : (r.startedAt ? `checked ${at(r.startedAt)}` : '');
    $('refresh').disabled = !!r.running;

    const banner = $('banner');
    banner.hidden = !r.error;
    banner.textContent = r.error || '';

    const head = $('head');
    clear(head);
    for (const [k, label, sortable, cls] of COLUMNS) {
      head.append(el('th', {
        class: [sortable ? 'sortable' : '', cls].filter(Boolean).join(' '),
        'aria-sort': sort === k ? 'descending' : null,
        onclick: sortable ? () => { sort = k; remember('sort', k); render(); } : null,
      }, k === 'actions' ? '' : label, sort === k ? ' ↓' : ''));
    }

    const body = $('rows');
    clear(body);
    const rows = visibleRows();
    if (!rows.some((o) => o.id === selId)) selId = null;
    rows.forEach((o) => body.append(row(o)));
    if (!rows.length) {
      body.append(el('tr', {}, el('td', { class: 'empty', colspan: String(COLUMNS.length) }, emptyText(r))));
    }

    const hidden = orgs.filter((o) => o.hidden).sort(byName);
    const toggle = $('toggle-hidden');
    toggle.hidden = hidden.length === 0;
    toggle.textContent = showHidden ? 'hide the hidden list' : `${hidden.length} hidden`;
    const list = $('hidden-rows');
    clear(list);
    if (showHidden) {
      hidden.forEach((o) => list.append(el('tr', {},
        el('td', {}, el('span', { class: 'name' }, o.alias)),
        el('td', { class: 'type' }, TYPES[o.type] || o.type),
        el('td', { class: 'col-note' }, o.note || ''),
        el('td', { class: 'actions' },
          el('button', { class: 'mini', type: 'button', onclick: () => update(o.id, { hidden: false }) }, 'Unhide')))));
    }
  }

  // --- wiring ------------------------------------------------------------------------------------
  $('search').addEventListener('input', (e) => { query = e.target.value.trim(); selId = null; render(); });
  $('refresh').addEventListener('click', refresh);
  $('settings').addEventListener('click', settingsDialog);
  $('toggle-hidden').addEventListener('click', () => { showHidden = !showHidden; render(); });
  // The header row sticks just under the bar, which wraps to two lines on narrow windows.
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--bar-h', `${document.querySelector('.bar').offsetHeight}px`);
  }).observe(document.querySelector('.bar'));
  window.addEventListener('focus', () => { if (!editing && !openDialog) load(); });
  api('/api/health').then((h) => { $('version').textContent = h.version || ''; }).catch(() => {});

  load().then(refresh);
})();
