/*
 * 国庆美西衣橱：先录衣服，再按固定行程每天点选搭配。
 *
 * 两个入口共用这一份代码：
 * - outfit.html 发布在 claude.ai 上，数据存在页面自带的存储（claude.use('db')），多设备同步；
 * - index.html 挂在 GitHub Pages 上，可以用 Safari「添加到主屏幕」当 App 用，
 *   数据存在这台设备的 localStorage，第一次打开从 seed.js 的定稿开始。
 */
(function () {
  'use strict';

  const MARKUP = "<div class=\"wrap\">\n  <header class=\"top\">\n    <div class=\"brand\">\n      <span class=\"script\" aria-hidden=\"true\">Dream Closet</span>\n      <h1>国庆美西衣橱</h1>\n      <span class=\"route\">SFO · LAX · LAS · PAGE · SLC · 黄石 · 9/25–10/9</span>\n    </div>\n    <div class=\"stats\" id=\"stats\">正在读取…</div>\n    <div class=\"tabs\" role=\"tablist\">\n      <button type=\"button\" role=\"tab\" id=\"tab-days\" data-tab=\"days\" aria-selected=\"true\">每天穿什么<small id=\"tab-days-n\"></small></button>\n      <button type=\"button\" role=\"tab\" id=\"tab-items\" data-tab=\"items\" aria-selected=\"false\">我的衣服<small id=\"tab-items-n\"></small></button>\n    </div>\n  </header>\n\n  <div id=\"notice\"></div>\n\n  <section id=\"view-days\" role=\"tabpanel\" aria-labelledby=\"tab-days\">\n    <div class=\"day-list\" id=\"day-list\"></div>\n  </section>\n\n  <section id=\"view-items\" role=\"tabpanel\" aria-labelledby=\"tab-items\" hidden>\n    <form class=\"add\" id=\"add-form\" autocomplete=\"off\">\n      <h2>加一件衣服</h2>\n      <div class=\"add-row\">\n        <input type=\"text\" id=\"add-name\" placeholder=\"比如：灰色卫衣\" maxlength=\"40\" aria-label=\"衣服名称\">\n        <button class=\"btn\" type=\"submit\" id=\"add-btn\">添加</button>\n      </div>\n      <div class=\"seg\" id=\"add-cat\" aria-label=\"类别\"></div>\n    </form>\n    <label class=\"filter\"><input type=\"checkbox\" id=\"only-unused\"> 只看还没安排到任何一天的</label>\n    <div id=\"item-list\"></div>\n    <p class=\"local-note\" id=\"local-note\" hidden>这些衣服和搭配存在这部手机上的这个 App 里，删掉 App 就没了。</p>\n  </section>\n</div>\n\n<div class=\"sheet\" id=\"sheet\" hidden role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"sheet-title\">\n  <div class=\"scrim\" data-act=\"close\"></div>\n  <div class=\"panel\">\n    <div class=\"sheet-top\">\n      <div>\n        <h2 id=\"sheet-title\"></h2>\n        <div class=\"meta\" id=\"sheet-meta\"></div>\n      </div>\n      <form class=\"quick\" id=\"quick-form\" autocomplete=\"off\">\n        <div class=\"row\">\n          <input type=\"text\" id=\"quick-name\" placeholder=\"加一件新衣服\" maxlength=\"40\" aria-label=\"新衣服名称\">\n          <select id=\"quick-cat\" aria-label=\"类别\"></select>\n          <button class=\"btn\" type=\"submit\">加上</button>\n        </div>\n      </form>\n    </div>\n    <div class=\"sheet-scroll\">\n      <div class=\"warns\" id=\"sheet-warns\"></div>\n      <div id=\"sheet-picks\"></div>\n      <div class=\"sheet-tools\">\n        <button class=\"btn ghost\" type=\"button\" id=\"copy-prev\">照搬前一天</button>\n        <button class=\"btn ghost\" type=\"button\" id=\"clear-day\">清空这天</button>\n      </div>\n      <details class=\"plan\" id=\"sheet-plan-box\">\n        <summary>原计划</summary>\n        <p id=\"sheet-plan\"></p>\n      </details>\n      <label class=\"field\">备注（提醒自己的话）\n        <textarea id=\"sheet-note\" maxlength=\"500\" placeholder=\"比如：洞洞鞋放随身包\"></textarea>\n      </label>\n    </div>\n    <div class=\"sheet-foot\">\n      <button class=\"btn\" type=\"button\" id=\"sheet-done\" data-act=\"close\">完成</button>\n    </div>\n  </div>\n</div>\n\n<div class=\"toast\" id=\"toast\" hidden></div>\n";
  (document.getElementById('app') || document.body).insertAdjacentHTML('afterbegin', MARKUP);

  const CATS = ['上衣', '中间层', '外套', '保暖内衣', '下装', '鞋', '配件'];
  const TMIN = -5, TMAX = 35;

  const S = {
    db: null,
    items: new Map(),
    days: [],
    outfits: new Map(),
    loaded: { items: false, days: false, outfits: false },
    tab: 'days',
    openDay: null,
    addCat: '上衣',
    editId: null,
    editDraft: null,
    confirmId: null,
    onlyUnused: false,
    failed: false
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  try { const t = localStorage.getItem('outfit-tab'); if (t === 'items' || t === 'days') S.tab = t; } catch (e) {}

  /* ---------- 小工具 ---------- */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
  function errText(e) {
    const code = e && e.code;
    if (code === 'quota_exceeded') return '存储满了，删掉几件不用的再加';
    if (code === 'invalid_argument') return '没有保存权限，只能看';
    if (code === 'resource_exhausted') return '点得太快了，稍等一下再试';
    return '没保存上，检查一下网络再点一次';
  }
  async function withRetry(fn) {
    try { return await fn(); }
    catch (e) {
      if (e && (e.code === 'unavailable' || !e.code)) {
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
        return fn();
      }
      throw e;
    }
  }
  function newId() { return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function sortedItems() {
    return Array.from(S.items.values()).sort((a, b) =>
      (CATS.indexOf(a.cat) - CATS.indexOf(b.cat)) || ((a.order || 0) - (b.order || 0)));
  }
  function outfitOf(dayId) {
    const o = S.outfits.get(dayId);
    return { items: (o && Array.isArray(o.items)) ? o.items.filter((id) => S.items.has(id)) : [], note: (o && o.note) || '' };
  }
  function usage() {
    const map = new Map();
    for (const d of S.days) {
      for (const id of outfitOf(d.id).items) {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(d);
      }
    }
    return map;
  }
  function warningsFor(day) {
    const cats = new Set(outfitOf(day.id).items.map((id) => S.items.get(id).cat));
    const out = [];
    if (!cats.size) return ['还没搭配'];
    if (!cats.has('上衣') && !cats.has('保暖内衣')) out.push('还没选上衣');
    if (!cats.has('下装')) out.push('还没选裤子 / 裙子');
    if (!cats.has('鞋')) out.push('还没选鞋');
    if (typeof day.lo === 'number' && day.lo <= 5 && !cats.has('外套')) out.push('最低 ' + day.lo + '°C，还没有外套');
    if (typeof day.lo === 'number' && day.lo <= 0 && !cats.has('保暖内衣')) out.push('会到 0°C 以下，考虑保暖内衣');
    return out;
  }
  function tempPos(t) { return Math.max(0, Math.min(100, (t - TMIN) / (TMAX - TMIN) * 100)); }
  function trackHtml(lo, hi) {
    if (typeof lo !== 'number' || typeof hi !== 'number') return '';
    const a = tempPos(lo), b = tempPos(hi), w = Math.max(b - a, 2);
    const size = 100 / w * 100;
    const pos = (100 - w) > 0 ? a / (100 - w) * 100 : 0;
    const zero = tempPos(0);
    return '<div class="temp"><span class="lo">' + lo + '°</span>' +
      '<div class="track" aria-label="气温 ' + lo + ' 到 ' + hi + ' 摄氏度">' +
      '<i style="left:' + a + '%;width:' + w + '%;background-size:' + size + '% 100%;background-position:' + pos + '% 0"></i>' +
      '<b style="left:' + zero + '%"></b></div>' +
      '<span class="hi">' + hi + '°</span></div>';
  }

  /* ---------- 渲染 ---------- */
  function render() {
    const ready = S.loaded.items && S.loaded.days && S.loaded.outfits;
    $('tab-days').setAttribute('aria-selected', String(S.tab === 'days'));
    $('tab-items').setAttribute('aria-selected', String(S.tab === 'items'));
    $('view-days').hidden = S.tab !== 'days';
    $('view-items').hidden = S.tab !== 'items';
    if (!ready) return;

    const use = usage();
    const unused = sortedItems().filter((it) => !use.has(it.id));
    const warnDays = S.days.filter((d) => warningsFor(d).length);
    $('stats').innerHTML =
      '<span><b>' + S.items.size + '</b> 件衣服</span>' +
      '<span><b>' + (S.days.length - warnDays.length) + '/' + S.days.length + '</b> 天搭好</span>' +
      '<span class="' + (unused.length ? 'is-warn' : '') + '"><b>' + unused.length + '</b> 件还没安排</span>';
    $('tab-days-n').textContent = S.days.length;
    $('tab-items-n').textContent = S.items.size;

    renderDays();
    renderItems(use);
    if (S.openDay) renderSheet();
  }

  function renderDays() {
    if (!S.days.length) {
      $('day-list').innerHTML = '<div class="notice">行程还没导进来。</div>';
      return;
    }
    $('day-list').innerHTML = S.days.map((d) => {
      const o = outfitOf(d.id);
      const byCat = CATS.map((c) => [c, o.items.map((id) => S.items.get(id)).filter((it) => it.cat === c)]).filter(([, l]) => l.length);
      const warns = warningsFor(d);
      return '<article class="day" data-day="' + esc(d.id) + '" tabindex="0" aria-label="' + esc(d.date + ' ' + d.title) + '，点开搭配">' +
        '<div class="day-head"><div class="tag">' + esc(d.date) + '<small>' + esc(d.wd || '') + '</small></div>' +
        '<div><h3>' + esc(d.title) + '</h3>' + (d.sub ? '<div class="sub">' + esc(d.sub) + '</div>' : '') + '</div></div>' +
        trackHtml(d.lo, d.hi) +
        (byCat.length
          ? '<div class="wear">' + byCat.map(([c, l]) => '<div class="wear-row"><span>' + c + '</span><div class="chips">' +
              l.map((it) => '<span class="chip">' + esc(it.name) + '</span>').join('') + '</div></div>').join('') + '</div>'
          : '<div class="empty-wear">点这里开始搭配</div>') +
        (o.note ? '<div class="day-note">' + esc(o.note) + '</div>' : '') +
        (warns.length && byCat.length ? '<div class="warns">' + warns.map((w) => '<span class="warn">' + esc(w) + '</span>').join('') + '</div>' : '') +
        (!warns.length ? '<div class="ok">♥ 搭好了</div>' : '') +
        '</article>';
    }).join('');
  }

  function renderItems(use) {
    $('add-cat').innerHTML = CATS.map((c) => '<button type="button" data-cat="' + c + '" aria-pressed="' + (S.addCat === c) + '">' + c + '</button>').join('');
    let list = sortedItems();
    if (S.onlyUnused) list = list.filter((it) => !use.has(it.id));
    if (!list.length) {
      $('item-list').innerHTML = '<div class="notice">' + (S.onlyUnused ? '每件衣服都安排上了。' : '还没有衣服，先在上面加几件。') + '</div>';
      return;
    }
    $('item-list').innerHTML = CATS.map((c) => {
      const l = list.filter((it) => it.cat === c);
      if (!l.length) return '';
      return '<div class="cat-block"><h3><span>' + c + '</span><span>' + l.length + '</span></h3><div class="items">' +
        l.map((it) => itemRow(it, use.get(it.id) || [])).join('') + '</div></div>';
    }).join('');
  }

  function itemRow(it, days) {
    const id = esc(it.id);
    if (S.editId === it.id) {
      const d = S.editDraft || { name: it.name, cat: it.cat };
      return '<div class="item editing" data-item="' + id + '">' +
        '<input type="text" id="edit-name" value="' + esc(d.name) + '" maxlength="40" aria-label="名称">' +
        '<div class="seg" id="edit-cat">' + CATS.map((c) => '<button type="button" data-editcat="' + c + '" aria-pressed="' + (d.cat === c) + '">' + c + '</button>').join('') + '</div>' +
        '<div class="acts"><button type="button" class="btn" data-act="save-edit">保存</button><button type="button" class="btn ghost" data-act="cancel-edit">取消</button></div></div>';
    }
    if (S.confirmId === it.id) {
      return '<div class="item confirming" data-item="' + id + '">' +
        '<p>删掉「' + esc(it.name) + '」？' + (days.length ? '会从 ' + days.length + ' 天的搭配里一起拿掉。' : '') + '</p>' +
        '<div class="acts"><button type="button" class="btn danger" data-act="do-delete">删掉</button><button type="button" class="btn ghost" data-act="cancel-delete">不删</button></div></div>';
    }
    const useHtml = days.length
      ? '<div class="use"><span class="n">穿 ' + days.length + ' 天</span>' + days.map((d) => '<span class="d">' + esc(d.date) + '</span>').join('') + '</div>'
      : '<div class="use none">还没安排到任何一天</div>';
    return '<div class="item" data-item="' + id + '"><div class="name">' + esc(it.name) + '</div>' + useHtml +
      '<div class="acts"><button type="button" data-act="edit">改</button><button type="button" data-act="delete">删</button></div></div>';
  }

  function renderSheet() {
    const d = S.days.find((x) => x.id === S.openDay);
    if (!d) { closeSheet(); return; }
    const o = outfitOf(d.id);
    const chosen = new Set(o.items);
    const use = usage();
    $('sheet-title').textContent = d.date + ' ' + (d.wd || '') + ' · ' + d.title;
    $('sheet-meta').textContent = (typeof d.lo === 'number' ? d.lo + '°C – ' + d.hi + '°C' : '') + (d.sub ? '  ·  ' + d.sub : '');
    const warns = warningsFor(d);
    $('sheet-warns').innerHTML = warns.length
      ? warns.map((w) => '<span class="warn">' + esc(w) + '</span>').join('')
      : '<span class="ok">♥ 搭好了</span>';
    $('sheet-picks').innerHTML = CATS.map((c) => {
      const l = sortedItems().filter((it) => it.cat === c);
      if (!l.length) return '';
      return '<div class="pick-group"><h4>' + c + '</h4><div class="chips">' + l.map((it) => {
        const others = (use.get(it.id) || []).filter((x) => x.id !== d.id).length;
        return '<button type="button" class="pick" data-pick="' + esc(it.id) + '" aria-pressed="' + chosen.has(it.id) + '">' +
          esc(it.name) + (others ? '<small>' + others + '天</small>' : '') + '</button>';
      }).join('') + '</div></div>';
    }).join('') || '<div class="notice">还没有衣服。先去「我的衣服」加，或者用下面的输入框直接加。</div>';
    const idx = S.days.indexOf(d);
    $('copy-prev').hidden = idx <= 0;
    if (idx > 0) $('copy-prev').textContent = '照搬前一天（' + S.days[idx - 1].date + '）';
    $('clear-day').disabled = !o.items.length;
    $('sheet-plan-box').hidden = !d.plan;
    $('sheet-plan').textContent = d.plan || '';
    if (document.activeElement !== $('sheet-note') && !noteTimer) $('sheet-note').value = o.note;
    $('quick-cat').innerHTML = CATS.map((c) => '<option' + (c === S.quickCat ? ' selected' : '') + '>' + c + '</option>').join('');
  }

  /* ---------- 写入 ---------- */
  const pending = new Map();
  const busy = new Set();
  function saveOutfit(dayId, body) {
    S.outfits.set(dayId, body);
    pending.set(dayId, body);
    flush(dayId);
    render();
  }
  async function flush(dayId) {
    if (busy.has(dayId) || !S.db) return;
    busy.add(dayId);
    try {
      while (pending.has(dayId)) {
        const body = pending.get(dayId);
        pending.delete(dayId);
        await withRetry(() => S.db.doc('outfits/' + dayId).set(body));
      }
    } catch (e) {
      pending.delete(dayId);
      toast(errText(e));
    } finally {
      busy.delete(dayId);
    }
  }

  async function addItem(name, cat) {
    name = name.trim();
    if (!name) return null;
    if (sortedItems().some((it) => it.name === name)) { toast('已经有「' + name + '」了'); return null; }
    const id = newId();
    const body = { name: name, cat: cat, order: Date.now() };
    S.items.set(id, Object.assign({ id: id }, body));
    render();
    try {
      await withRetry(() => S.db.doc('items/' + id).set(body));
      return id;
    } catch (e) {
      S.items.delete(id);
      render();
      toast(errText(e));
      return null;
    }
  }

  async function deleteItem(id) {
    const it = S.items.get(id);
    if (!it) return;
    for (const d of S.days) {
      const o = outfitOf(d.id);
      if (o.items.includes(id)) saveOutfit(d.id, { items: o.items.filter((x) => x !== id), note: o.note });
    }
    S.items.delete(id);
    render();
    try { await withRetry(() => S.db.doc('items/' + id).delete()); toast('删掉了「' + it.name + '」'); }
    catch (e) { toast(errText(e)); }
  }

  async function saveEdit(id) {
    const it = S.items.get(id);
    const d = S.editDraft;
    if (!it || !d) return;
    const name = d.name.trim();
    if (!name) { toast('名称不能空着'); return; }
    S.editId = null; S.editDraft = null;
    if (name === it.name && d.cat === it.cat) { render(); return; }
    S.items.set(id, Object.assign({}, it, { name: name, cat: d.cat }));
    render();
    try { await withRetry(() => S.db.doc('items/' + id).update({ name: name, cat: d.cat })); }
    catch (e) { toast(errText(e)); }
  }

  /* ---------- 面板 ---------- */
  let lastFocus = null;
  function openSheet(dayId) {
    lastFocus = document.activeElement;
    S.openDay = dayId;
    S.quickCat = S.quickCat || '上衣';
    $('sheet-note').value = outfitOf(dayId).note;
    $('sheet-plan-box').open = false;
    $('sheet').hidden = false;
    document.body.style.overflow = 'hidden';
    renderSheet();
    $('sheet-done').focus();
  }
  function closeSheet() {
    flushNote();
    S.openDay = null;
    $('sheet').hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  let noteTimer = 0;
  function flushNote() {
    if (!noteTimer || !S.openDay) return;
    clearTimeout(noteTimer);
    noteTimer = 0;
    const o = outfitOf(S.openDay);
    const note = $('sheet-note').value.trim();
    if (note !== o.note) saveOutfit(S.openDay, { items: o.items, note: note });
  }

  /* ---------- 事件 ---------- */
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab;
    try { localStorage.setItem('outfit-tab', S.tab); } catch (err) {}
    render();
    window.scrollTo(0, 0);
  });

  $('day-list').addEventListener('click', (e) => {
    const card = e.target.closest('[data-day]');
    if (card) openSheet(card.dataset.day);
  });
  $('day-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-day]');
    if (card) { e.preventDefault(); openSheet(card.dataset.day); }
  });

  $('add-cat').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    S.addCat = b.dataset.cat;
    render();
  });
  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('add-name');
    const name = input.value;
    if (!name.trim()) { input.focus(); return; }
    input.value = '';
    const id = await addItem(name, S.addCat);
    if (id) toast('加上了「' + name.trim() + '」· ' + S.addCat);
    input.focus();
  });
  $('only-unused').addEventListener('change', (e) => { S.onlyUnused = e.target.checked; render(); });

  $('item-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-item]');
    if (!row) return;
    const id = row.dataset.item;
    const cat = e.target.closest('[data-editcat]');
    if (cat) { S.editDraft.cat = cat.dataset.editcat; render(); return; }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;
    if (a === 'edit') {
      const it = S.items.get(id);
      S.editId = id; S.confirmId = null;
      S.editDraft = { name: it.name, cat: it.cat };
      render();
      const inp = $('edit-name'); if (inp) { inp.focus(); inp.select(); }
    } else if (a === 'cancel-edit') { S.editId = null; S.editDraft = null; render(); }
    else if (a === 'save-edit') saveEdit(id);
    else if (a === 'delete') { S.confirmId = id; S.editId = null; render(); }
    else if (a === 'cancel-delete') { S.confirmId = null; render(); }
    else if (a === 'do-delete') { S.confirmId = null; deleteItem(id); }
  });
  $('item-list').addEventListener('input', (e) => {
    if (e.target.id === 'edit-name' && S.editDraft) S.editDraft.name = e.target.value;
  });
  $('item-list').addEventListener('keydown', (e) => {
    if (e.target.id === 'edit-name' && e.key === 'Enter') { e.preventDefault(); saveEdit(S.editId); }
  });

  $('sheet').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="close"]')) { closeSheet(); return; }
    const p = e.target.closest('[data-pick]');
    if (p && S.openDay) {
      const o = outfitOf(S.openDay);
      const id = p.dataset.pick;
      const items = o.items.includes(id) ? o.items.filter((x) => x !== id) : o.items.concat(id);
      saveOutfit(S.openDay, { items: items, note: o.note });
    }
  });
  $('copy-prev').addEventListener('click', () => {
    const idx = S.days.findIndex((x) => x.id === S.openDay);
    if (idx <= 0) return;
    const prev = outfitOf(S.days[idx - 1].id);
    const o = outfitOf(S.openDay);
    saveOutfit(S.openDay, { items: prev.items.slice(), note: o.note });
    toast('照搬了 ' + S.days[idx - 1].date + ' 的 ' + prev.items.length + ' 件');
  });
  $('clear-day').addEventListener('click', () => {
    const o = outfitOf(S.openDay);
    saveOutfit(S.openDay, { items: [], note: o.note });
  });
  $('sheet-note').addEventListener('input', () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNote, 700);
  });
  $('sheet-note').addEventListener('blur', flushNote);
  $('quick-cat').addEventListener('change', (e) => { S.quickCat = e.target.value; });
  $('quick-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('quick-name');
    const name = input.value;
    const dayId = S.openDay;
    if (!name.trim() || !dayId) { input.focus(); return; }
    input.value = '';
    const id = await addItem(name, $('quick-cat').value);
    if (id && S.openDay === dayId) {
      const o = outfitOf(dayId);
      saveOutfit(dayId, { items: o.items.concat(id), note: o.note });
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.openDay) closeSheet(); });

  /* ---------- 连接存储 ---------- */
  function fail(msg) {
    S.failed = true;
    $('stats').textContent = '';
    $('notice').innerHTML = '<div class="notice is-warn">' + msg + '</div>';
  }
  function onDbError(e) {
    if (e && e.code === 'revoked') fail('这个页面的存储权限被收回了，刷新一下试试。');
    else toast('同步断了，刷新一下页面');
  }

  /* 本地存储：接口和 claude.use('db') 里用到的那部分一致，上面的代码不用分两套写 */
  function createLocalDB(seed) {
    const KEY = 'outfit-closet-v1';
    let data = null;
    let warned = false;
    try { const raw = localStorage.getItem(KEY); if (raw) data = JSON.parse(raw); } catch (e) {}
    if (!data || typeof data !== 'object' || !data.items) data = JSON.parse(JSON.stringify(seed));
    const subs = {};
    function persist() {
      try { localStorage.setItem(KEY, JSON.stringify(data)); }
      catch (e) { if (!warned) { warned = true; toast('这台设备存不下，关掉 App 后改动会丢'); } }
    }
    function snapshot(name, orderField) {
      const col = data[name] || {};
      const docs = Object.keys(col).map((id) => ({ id: id, exists: true, data: () => col[id] }));
      if (orderField) docs.sort((a, b) => (col[a.id][orderField] ?? Infinity) - (col[b.id][orderField] ?? Infinity));
      else docs.sort((a, b) => (a.id < b.id ? -1 : 1));
      return { docs: docs, size: docs.length, empty: !docs.length };
    }
    function notify(name) {
      for (const s of subs[name] || []) setTimeout(() => s.next(snapshot(name, s.order)), 0);
    }
    function doc(path) {
      const parts = path.split('/');
      const name = parts[0], id = parts[1];
      return {
        set: async (body) => { (data[name] = data[name] || {})[id] = JSON.parse(JSON.stringify(body)); persist(); notify(name); },
        update: async (body) => {
          const col = data[name] || {};
          if (!col[id]) throw { code: 'invalid_argument' };
          col[id] = Object.assign({}, col[id], JSON.parse(JSON.stringify(body)));
          persist(); notify(name);
        },
        delete: async () => { if (data[name]) delete data[name][id]; persist(); notify(name); }
      };
    }
    function collection(name, order) {
      return {
        orderBy: (field) => collection(name, field),
        doc: (id) => doc(name + '/' + id),
        onSnapshot: (next) => {
          const s = { next: next, order: order };
          (subs[name] = subs[name] || new Set()).add(s);
          setTimeout(() => next(snapshot(name, order)), 0);
          return () => subs[name].delete(s);
        }
      };
    }
    return { collection: (name) => collection(name), doc: doc };
  }

  function connect(db) {
    S.db = db;
    db.collection('items').onSnapshot((snap) => {
      const next = new Map();
      for (const d of snap.docs) next.set(d.id, Object.assign({ id: d.id }, d.data()));
      S.items = next;
      S.loaded.items = true;
      render();
    }, onDbError);
    db.collection('days').orderBy('order').onSnapshot((snap) => {
      S.days = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      S.loaded.days = true;
      render();
    }, onDbError);
    db.collection('outfits').onSnapshot((snap) => {
      const next = new Map();
      for (const d of snap.docs) next.set(d.id, d.data());
      for (const id of busy) if (S.outfits.has(id)) next.set(id, S.outfits.get(id));
      for (const [id, body] of pending) next.set(id, body);
      S.outfits = next;
      S.loaded.outfits = true;
      render();
    }, onDbError);
  }

  render();
  const hasClaude = window.claude && typeof window.claude.use === 'function';
  if (hasClaude) {
    window.claude.use('db').then((db) => {
      if (!db) { fail('读不到存储。刷新一下；还不行的话，用分享给你的 claude.ai 链接打开。'); return; }
      connect(db);
    }, () => fail('读不到存储，刷新一下试试。'));
  } else if (window.OUTFIT_SEED) {
    $('local-note').hidden = false;
    connect(createLocalDB(window.OUTFIT_SEED));
  } else {
    fail('这个页面要在 claude.ai 里打开才能读写数据。');
  }
})();
