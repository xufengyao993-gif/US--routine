/* 界面与交互：状态管理、协作写入、渲染 */
(function (global) {
  'use strict';

  const U = global.Util;
  const S = global.Store;
  const M = global.Maps;
  const Model = global.Model;
  const Sync = global.Sync;
  const Config = global.Config;

  const LAST_TRIP_KEY = 'us-routine.last-trip';

  const state = {
    trip: null,
    tripId: null,
    activeDayId: null,
    activeStopId: null,
    schedule: null,
    presence: [],
    history: [],
    claimed: false,
    pendingRender: false
  };

  const $ = function (id) { return document.getElementById(id); };

  /* ================= 启动 ================= */
  function boot() {
    const cfg = Config.load();
    state.tripId = resolveTripId();
    state.trip = S.loadTrip(state.tripId) || S.sampleTrip();
    state.history = S.loadHistory(state.tripId);
    ensureActiveDay();

    bindControls();
    bindMobileTabs();
    registerServiceWorker();
    render();

    // 同步（没配 Firebase 就是本地模式）
    Sync.init({
      config: cfg.firebase,
      tripId: state.tripId,
      onTrip: onRemoteTrip,
      onPresence: onPresence,
      onHistory: onRemoteHistory,
      onStatus: onSyncStatus
    });

    // 地图
    if (cfg.mapsApiKey) startMaps(cfg.mapsApiKey);
    else showMapNotice('还没填 Google Maps API Key。时间轴照常可用（路程按直线距离估算），填上 Key 后就有地图打点、连线和真实路况耗时。', true);
  }

  function resolveTripId() {
    const params = new URLSearchParams(location.search);
    let id = params.get('trip');
    if (!id) id = localStorage.getItem(LAST_TRIP_KEY);
    if (!id) id = Model.newTripId();
    localStorage.setItem(LAST_TRIP_KEY, id);
    if (params.get('trip') !== id) {
      params.set('trip', id);
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
    }
    return id;
  }

  function startMaps(key) {
    showMapNotice('地图加载中…', false);
    M.loadApi(key).then(function () {
      M.initMap($('map'));
      hideMapNotice();
      attachDialogAutocomplete();
      return refreshLegs(true);
    }).catch(function (err) {
      console.error(err);
      showMapNotice('地图加载失败：' + err.message, true);
    });
  }

  /* ================= 同步回调 ================= */
  function onRemoteTrip(remote) {
    if (!remote || !remote.days) {
      // 云端还没有这份行程：本人是第一个进来的，把本地这份传上去
      if (Sync.isOnline() && !state.claimed) {
        state.claimed = true;
        Sync.replaceAll(state.trip);
      }
      return;
    }
    state.claimed = true;
    state.trip = Model.migrate(remote);
    S.saveTrip(state.trip, state.tripId);
    ensureActiveDay();
    renderGuarded();
    if (M.isReady()) refreshLegs(true);
  }

  function onPresence(list) {
    const me = Sync.getMe();
    state.presence = list.filter(function (p) { return !me || p.id !== me.id; });
    renderPresence();
    renderTimelineOnly();
  }

  function onSyncStatus(mode, error) {
    const bar = $('syncBar');
    const map = {
      local: null,
      connecting: { text: '正在连接协作服务…', cls: 'is-info' },
      online: null,
      offline: { text: '📴 当前离线：改动会先存在这台设备，联网后自动同步给同伴', cls: 'is-warn' },
      error: { text: '⚠️ 协作服务连接失败' + (error ? '（' + error + '）' : '') + '，暂时只在本机保存', cls: 'is-warn' }
    };
    const info = map[mode];
    if (!info) {
      bar.hidden = true;
      if (mode === 'online') toast('已连上协作服务，改动会实时同步');
    } else {
      bar.textContent = info.text;
      bar.className = 'sync-bar ' + info.cls;
      bar.hidden = false;
    }
    renderPresence();
  }

  /* ================= 写入（本地优先 + 推补丁 + 记一笔） =================
   * 所有改动都走这里：
   *   1. 先算出「反操作」（这些路径改之前是什么），撤销就靠它
   *   2. 应用到本地并立刻重绘
   *   3. 把补丁推给同伴
   *   4. 记一条修改记录，谁改的、改了什么、怎么撤
   */
  function change(patch, meta) {
    if (!patch || !Object.keys(patch).length) return;
    const inverse = Model.inverseOf(state.trip, patch);
    Object.keys(patch).forEach(function (path) {
      Model.setAtPath(state.trip, path, patch[path]);
    });
    S.saveTrip(state.trip, state.tripId);
    Sync.push(patch);
    if (!meta || !meta.silent) recordHistory(patch, inverse, meta || {});
  }

  /** 整份行程替换（导入 / 载入示例 / 撤销这两件事） */
  function replaceTrip(next, meta) {
    const before = JSON.parse(JSON.stringify(state.trip));
    state.trip = Model.migrate(next);
    state.activeDayId = null;
    state.activeStopId = null;
    ensureActiveDay();
    S.saveTrip(state.trip, state.tripId);
    Sync.replaceAll(state.trip);
    recordHistory(null, null, Object.assign({ root: { before: before } }, meta || {}));
    render();
    if (M.isReady()) refreshLegs(true);
  }

  function dayPath(dayId) { return 'days/' + dayId; }
  function stopPath(dayId, stopId) { return 'days/' + dayId + '/stops/' + stopId; }

  /* ================= 修改记录与撤销 ================= */
  const HISTORY_KEEP = 60;      // 本地和云端各保留多少条

  function recordHistory(patch, inverse, meta) {
    const me = Sync.getMe();
    const entry = {
      id: U.uid('h'),
      ts: Date.now(),
      who: me ? me.name : '我',
      byMe: true,
      color: me ? me.color : '#64748b',
      action: meta.action || 'edit',
      summary: meta.summary || '改动了行程',
      patch: patch || null,
      inverse: inverse || null,
      root: meta.root || null,
      undoOf: meta.undoOf || null
    };
    state.history.push(entry);
    trimAndSaveHistory();
    Sync.pushHistory(Object.assign({}, entry, { byMe: null }));
    renderHistoryIfOpen();
  }

  function onRemoteHistory(list) {
    // 云端是准的；本人写的那几条补上 byMe 标记，方便「只看我的」和快捷键撤销
    const mine = {};
    state.history.forEach(function (e) { if (e.byMe) mine[e.id] = true; });
    state.history = list.map(function (e) {
      return Object.assign({}, e, { byMe: !!mine[e.id] });
    });
    trimAndSaveHistory();
    renderHistoryIfOpen();

    // 谁的记录多到该清了，就顺手清一下最老的
    if (Sync.isOnline() && list.length > HISTORY_KEEP * 2) {
      const sorted = list.slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      Sync.trimHistory(sorted.slice(0, list.length - HISTORY_KEEP).map(function (e) { return e.id; }));
    }
  }

  function trimAndSaveHistory() {
    state.history.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    if (state.history.length > HISTORY_KEEP) {
      state.history = state.history.slice(state.history.length - HISTORY_KEEP);
    }
    S.saveHistory(state.tripId, state.history);
  }

  /** 记录倒序（最新在前） */
  function historyDesc() {
    return state.history.slice().reverse();
  }

  /** 这条记录还能不能撤：父节点被别人删掉之后就撤不了了 */
  function undoBlockReason(entry) {
    if (entry.undone) return '已经撤销过了';
    if (entry.root) return null;
    if (!entry.inverse || !Object.keys(entry.inverse).length) return '这条记录没有可撤销的内容';
    const bad = Object.keys(entry.inverse).filter(function (path) {
      if (entry.inverse[path] === null) return false;       // 撤销后是删除，父节点在不在都无所谓
      const parts = path.split('/').filter(Boolean);
      if (parts.length < 2) return false;
      const parent = parts.slice(0, -1).join('/');
      return Model.getAtPath(state.trip, parent) == null;
    });
    return bad.length ? '它所在的地点或那一天已经被删掉了' : null;
  }

  function undoEntry(entry) {
    const reason = undoBlockReason(entry);
    if (reason) { toast('撤销不了：' + reason); return; }

    if (entry.root) {
      replaceTrip(entry.root.before, { action: 'undo', summary: '撤销了：' + entry.summary, undoOf: entry.id });
    } else {
      change(entry.inverse, { action: 'undo', summary: '撤销了：' + entry.summary, undoOf: entry.id });
      render();
      if (M.isReady()) refreshLegs(true);
    }

    // 把原记录标成已撤销
    const target = state.history.filter(function (e) { return e.id === entry.id; })[0];
    if (target) {
      target.undone = true;
      trimAndSaveHistory();
      Sync.pushHistory(Object.assign({}, target, { byMe: null }));
    }
    renderHistoryIfOpen();
    toast('已撤销：' + entry.summary);
  }

  /** 快捷键撤销：只撤自己最近那条还没撤过的 */
  function undoMyLast() {
    const mine = historyDesc().filter(function (e) {
      return e.byMe && !e.undone && e.action !== 'undo' && !undoBlockReason(e);
    });
    if (!mine.length) { toast('没有可撤销的改动'); return; }
    undoEntry(mine[0]);
  }

  function openHistory() {
    renderHistory();
    $('historyDialog').showModal();
  }

  function renderHistoryIfOpen() {
    if ($('historyDialog').open) renderHistory();
  }

  let historyFilterMine = false;

  function renderHistory() {
    const list = $('historyList');
    list.innerHTML = '';
    const entries = historyDesc().filter(function (e) { return !historyFilterMine || e.byMe; });

    $('historyMineBtn').classList.toggle('is-on', historyFilterMine);
    $('historyCount').textContent = Sync.getMode() === 'local'
      ? '（本机记录，未连协作服务）' : '（大家的改动都在这里）';

    if (!entries.length) {
      list.appendChild(U.el('div', { class: 'empty', text: '还没有改动记录' }));
      return;
    }

    entries.forEach(function (e) {
      const reason = undoBlockReason(e);
      list.appendChild(U.el('div', { class: 'history-item' + (e.undone ? ' is-undone' : '') }, [
        U.el('span', { class: 'avatar', style: 'background:' + (e.color || '#64748b'), text: U.initials(e.who) }),
        U.el('div', { class: 'history-body' }, [
          U.el('div', { class: 'history-summary', text: e.summary }),
          U.el('div', { class: 'history-meta', text: (e.byMe ? '我' : e.who) + ' · ' + U.relTime(e.ts) + (e.undone ? ' · 已撤销' : '') })
        ]),
        e.action === 'undo' || e.undone ? null : U.el('button', {
          class: 'link-btn ghost' + (reason ? ' is-disabled' : ''),
          title: reason || '把这条改动还原',
          text: '撤销',
          onclick: function () { undoEntry(e); }
        })
      ]));
    });
  }

  /* ================= 渲染 ================= */
  function ensureActiveDay() {
    const days = Model.dayList(state.trip);
    if (!days.length) {
      state.activeDayId = null;
      return;
    }
    if (!state.activeDayId || !days.some(function (d) { return d.id === state.activeDayId; })) {
      state.activeDayId = days[0].id;
    }
  }

  function currentDay() {
    return Model.dayList(state.trip).filter(function (d) { return d.id === state.activeDayId; })[0] || null;
  }

  /** 正在输入时不要被同伴的改动打断，等失焦再重绘 */
  function renderGuarded() {
    const ae = document.activeElement;
    const typing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && !ae.closest('dialog');
    if (typing) {
      if (!state.pendingRender) {
        state.pendingRender = true;
        ae.addEventListener('blur', function once() {
          ae.removeEventListener('blur', once);
          state.pendingRender = false;
          render();
        });
      }
      return;
    }
    render();
  }

  function render() {
    $('tripTitle').value = state.trip.title || '';
    renderDayTabs();
    renderPresence();

    const day = currentDay();
    if (!day) {
      $('timeline').innerHTML = '<div class="empty">还没有行程，点上面的「+ 新的一天」开始。</div>';
      $('dayMeta').innerHTML = '';
      return;
    }

    const stops = Model.stopList(day);
    state.schedule = global.Schedule.computeDay(
      { startTime: day.startTime, stops: stops },
      function (from, to, mode) { return S.getLeg(from, to, mode); }
    );

    renderDayMeta(day, state.schedule.summary);
    renderTimeline(day, state.schedule.items);

    if (M.isReady()) {
      M.renderDay(day, state.schedule.items, {
        activeStopId: state.activeStopId,
        onMarkerClick: function (id) {
          state.activeStopId = id;
          renderTimelineOnly();
          const card = document.querySelector('[data-stop-card="' + id + '"]');
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }
  }

  function renderTimelineOnly() {
    const day = currentDay();
    if (day && state.schedule) renderTimeline(day, state.schedule.items);
  }

  function renderPresence() {
    const wrap = $('presence');
    wrap.innerHTML = '';
    const me = Sync.getMe();
    const mode = Sync.getMode();
    if (mode === 'local') {
      wrap.appendChild(U.el('span', { class: 'presence-hint', text: '仅本机' }));
      return;
    }
    const all = (me ? [{ id: me.id, name: me.name + '（我）', color: me.color }] : []).concat(state.presence);
    all.slice(0, 5).forEach(function (p) {
      wrap.appendChild(U.el('span', {
        class: 'avatar', title: p.name, style: 'background:' + (p.color || '#64748b'),
        text: U.initials(p.name)
      }));
    });
    if (all.length > 5) wrap.appendChild(U.el('span', { class: 'avatar avatar-more', text: '+' + (all.length - 5) }));
  }

  function renderDayTabs() {
    const wrap = $('dayTabs');
    wrap.innerHTML = '';
    Model.dayList(state.trip).forEach(function (day, i) {
      wrap.appendChild(U.el('button', {
        class: 'daytab' + (day.id === state.activeDayId ? ' is-active' : ''),
        onclick: function () {
          state.activeDayId = day.id;
          state.activeStopId = null;
          render();
          if (M.isReady()) refreshLegs(true);
        }
      }, [
        U.el('span', { class: 'daytab-day', text: 'Day ' + (i + 1) }),
        U.el('span', { class: 'daytab-date', text: U.formatDate(day.date) })
      ]));
    });
    wrap.appendChild(U.el('button', { class: 'daytab daytab-add', text: '+ 新的一天', onclick: addDay }));
  }

  function renderDayMeta(day, sum) {
    const meta = $('dayMeta');
    meta.innerHTML = '';
    meta.appendChild(U.el('div', { class: 'day-title-row' }, [
      U.el('input', {
        class: 'day-title', value: day.title, placeholder: '这一天叫什么',
        onchange: function (e) {
          const p = {}; p[dayPath(day.id) + '/title'] = e.target.value;
          change(p, { action: 'day', summary: '把这一天改名为「' + e.target.value + '」' });
          renderDayTabs();
        }
      }),
      U.el('button', { class: 'icon-btn', title: '删除这一天', text: '🗑', onclick: removeDay })
    ]));

    meta.appendChild(U.el('div', { class: 'day-inputs' }, [
      U.el('label', {}, [
        U.el('span', { text: '日期' }),
        U.el('input', {
          type: 'date', value: day.date,
          onchange: function (e) {
            const p = {}; p[dayPath(day.id) + '/date'] = e.target.value;
            change(p, { action: 'day', summary: '把「' + day.title + '」的日期改成 ' + e.target.value });
            renderDayTabs();
          }
        })
      ]),
      U.el('label', {}, [
        U.el('span', { text: '当天出发' }),
        U.el('input', {
          type: 'time', value: day.startTime,
          onchange: function (e) {
            const p = {}; p[dayPath(day.id) + '/startTime'] = e.target.value || '09:00';
            change(p, { action: 'day', summary: '把「' + day.title + '」的出发时间改成 ' + (e.target.value || '09:00') });
            render();
          }
        })
      ])
    ]));

    const chips = [
      ['🚪 出门', U.toClock(sum.leaveHomeAt)],
      ['🎯 游玩', U.toDuration(sum.totalStay)],
      ['🚗 路上', U.toDuration(sum.totalTravel)],
      ['📏 里程', sum.totalKm ? sum.totalKm + ' km' : '--'],
      ['🍜 吃饭', sum.foodCount + ' 顿'],
      ['🏁 结束', U.toClock(sum.dayEndAt)]
    ];
    meta.appendChild(U.el('div', { class: 'summary' }, chips.map(function (c) {
      return U.el('div', { class: 'summary-chip' }, [
        U.el('span', { class: 'summary-label', text: c[0] }),
        U.el('span', { class: 'summary-value', text: c[1] })
      ]);
    })));

    if (sum.lateCount > 0) {
      meta.appendChild(U.el('div', {
        class: 'warn-bar',
        text: '⚠️ 有 ' + sum.lateCount + ' 个预约时间赶不上，看下面标红的段落，可以缩短前面的停留或换交通方式。'
      }));
    }
    if (sum.totalWait > 20) {
      meta.appendChild(U.el('div', {
        class: 'info-bar',
        text: '⏳ 全天有 ' + U.toDuration(sum.totalWait) + ' 的空档（到得比预约早），可以加个附近的点。'
      }));
    }
  }

  function renderTimeline(day, items) {
    const tl = $('timeline');
    const scrollTop = tl.scrollTop;
    tl.innerHTML = '';
    if (!items.length) {
      tl.appendChild(U.el('div', { class: 'empty', text: '这一天还是空的，点下面「+ 添加地点」。' }));
      return;
    }
    items.forEach(function (item, i) {
      if (item.leg) tl.appendChild(renderLeg(day, item, items[i - 1]));
      tl.appendChild(renderStopCard(day, item, i, items.length));
    });
    tl.scrollTop = scrollTop;
  }

  function renderLeg(day, item, prevItem) {
    const leg = item.leg;
    const mode = U.MODES[leg.mode] || U.MODES.DRIVING;
    const isFood = item.stop.category === 'food';
    const late = item.lateBy > 0;

    const rows = [];
    rows.push(U.el('div', { class: 'leg-head' }, [
      U.el('span', { class: 'leg-mode', text: mode.icon + ' ' + mode.label }),
      U.el('span', { class: 'leg-dur', text: U.toDuration(leg.minutes) }),
      leg.km != null ? U.el('span', { class: 'leg-km', text: leg.km + ' km' }) : null,
      leg.estimated ? U.el('span', { class: 'badge badge-muted', title: '未接入 Directions API 或该段抓取失败，按直线距离估算', text: '估算' }) : null
    ]));

    rows.push(U.el('div', { class: 'leg-times' }, [
      U.el('strong', { text: U.toClock(leg.departAt) }),
      U.el('span', { text: ' 从「' + (prevItem ? prevItem.stop.name : '上一站') + '」出门 → ' }),
      U.el('strong', { text: U.toClock(leg.arriveAt) }),
      U.el('span', { text: ' 到达' })
    ]));

    if (leg.latestDeparture != null) {
      rows.push(U.el('div', { class: 'leg-deadline' + (late ? ' is-late' : '') }, [
        U.el('span', { text: (late ? '❗ 已经晚了 ' + U.toDuration(item.lateBy) + '：' : '⏰ ') }),
        U.el('span', { text: '要赶上 ' + U.toClock(U.toMinutes(item.stop.fixedStart)) + ' 的安排，最晚 ' }),
        U.el('strong', { text: U.toClock(leg.latestDeparture) }),
        U.el('span', { text: ' 必须出发' })
      ]));
    }

    rows.push(U.el('div', { class: 'leg-actions' }, [
      U.el('a', {
        class: 'link-btn', target: '_blank', rel: 'noopener',
        href: navUrl(leg.from, leg.to, leg.mode),
        text: isFood ? '🍜 导航去吃饭' : '🧭 导航'
      }),
      U.el('button', { class: 'link-btn ghost', text: '换交通方式', onclick: function () { cycleMode(day, item.stop); } })
    ]));

    return U.el('div', { class: 'leg' + (isFood ? ' leg-food' : '') + (late ? ' leg-late' : '') }, rows);
  }

  function renderStopCard(day, item, i, total) {
    const stop = item.stop;
    const cat = U.CATEGORIES[stop.category] || U.CATEGORIES.other;
    const active = state.activeStopId === stop.id;
    const editor = state.presence.filter(function (p) { return p.editing === stop.id; })[0];

    const badges = [];
    if (item.isFixed) badges.push(U.el('span', { class: 'badge badge-fixed', text: '固定 ' + stop.fixedStart }));
    if (item.waitMin > 0) badges.push(U.el('span', { class: 'badge badge-wait', text: '空档 ' + U.toDuration(item.waitMin) }));
    if (item.lateBy > 0) badges.push(U.el('span', { class: 'badge badge-late', text: '迟到 ' + U.toDuration(item.lateBy) }));
    if (stop.lat == null) badges.push(U.el('span', { class: 'badge badge-muted', text: '缺坐标' }));
    if (editor) badges.push(U.el('span', { class: 'badge badge-editing', style: 'color:' + (editor.color || '#2563eb'), text: '✏️ ' + editor.name + ' 正在改' }));

    return U.el('div', {
      class: 'stop' + (active ? ' is-active' : '') + (editor ? ' is-editing' : ''),
      'data-stop-card': stop.id,
      style: '--cat-color:' + cat.color,
      onclick: function () {
        state.activeStopId = stop.id;
        renderTimelineOnly();
        if (M.isReady()) {
          M.focusStop(stop);
          M.renderDay(day, state.schedule.items, { activeStopId: state.activeStopId, keepViewport: true });
        }
      }
    }, [
      U.el('div', { class: 'stop-grip' }, [
        U.el('div', { class: 'stop-num', text: String(i + 1) }),
        U.el('div', { class: 'drag-handle', title: '按住拖动排序', text: '⠿' })
      ]),
      U.el('div', { class: 'stop-body' }, [
        U.el('div', { class: 'stop-head' }, [
          U.el('span', { class: 'stop-name', text: cat.icon + ' ' + stop.name }),
          U.el('span', { class: 'stop-time', text: U.toClock(item.startAt) + ' – ' + U.toClock(item.departAt) })
        ]),
        U.el('div', { class: 'stop-sub' }, [
          U.el('span', { class: 'stop-stay', text: '停留 ' + U.toDuration(item.stayMin) }),
          stop.address ? U.el('span', { class: 'stop-addr', text: ' · ' + stop.address }) : null
        ]),
        badges.length ? U.el('div', { class: 'stop-badges' }, badges) : null,
        stop.notes ? U.el('div', { class: 'stop-notes', text: '📝 ' + stop.notes }) : null,
        U.el('div', { class: 'stop-actions' }, [
          U.el('button', { class: 'link-btn ghost', text: '编辑', onclick: function (e) { e.stopPropagation(); openStopDialog(day, stop); } }),
          U.el('button', { class: 'link-btn ghost', text: '↑', title: '上移', disabled: i === 0 ? 'disabled' : null, onclick: function (e) { e.stopPropagation(); moveStop(day, i, -1); } }),
          U.el('button', { class: 'link-btn ghost', text: '↓', title: '下移', disabled: i === total - 1 ? 'disabled' : null, onclick: function (e) { e.stopPropagation(); moveStop(day, i, 1); } }),
          U.el('button', { class: 'link-btn ghost danger', text: '删除', onclick: function (e) { e.stopPropagation(); removeStop(day, stop); } })
        ])
      ])
    ]);
  }

  function navUrl(from, to, mode) {
    const base = 'https://www.google.com/maps/dir/?api=1';
    const o = from && from.lat != null ? from.lat + ',' + from.lng : encodeURIComponent(from ? from.name : '');
    const d = to && to.lat != null ? to.lat + ',' + to.lng : encodeURIComponent(to ? to.name : '');
    return base + '&origin=' + o + '&destination=' + d + '&travelmode=' + (mode || 'driving').toLowerCase();
  }

  /* ================= 行程编辑 ================= */
  function addDay() {
    const days = Model.dayList(state.trip);
    const day = S.newDay(days.length, Model.nextOrder(state.trip.days));
    const prev = days[days.length - 1];
    if (prev && prev.date) {
      const nd = new Date(prev.date + 'T00:00:00');
      nd.setDate(nd.getDate() + 1);
      day.date = nd.toISOString().slice(0, 10);
    }
    state.activeDayId = day.id;
    const p = {}; p[dayPath(day.id)] = day;
    change(p, { action: 'day-add', summary: '新增了一天：' + day.title });
    render();
  }

  function removeDay() {
    const day = currentDay();
    if (!day) return;
    if (!confirm('删除「' + day.title + '」这一天的全部行程？同伴那边也会删掉。')) return;
    const p = {}; p[dayPath(day.id)] = null;
    change(p, { action: 'day-delete', summary: '删掉了一天：' + day.title });
    state.activeDayId = null;
    ensureActiveDay();
    render();
  }

  function moveStop(day, index, delta) {
    moveStopTo(day, index, index + delta);
  }

  /** 把第 from 个地点挪到第 to 位（↑↓ 按钮和拖拽都走这里） */
  function moveStopTo(day, from, to) {
    const stops = Model.stopList(day);
    if (from === to || to < 0 || to >= stops.length) return;
    const moving = stops[from];
    const order = Model.orderForMove(stops, from, to);
    const patch = {};

    if (order == null) {
      // order 精度用尽，整天重排一次
      const reordered = stops.slice();
      reordered.splice(from, 1);
      reordered.splice(to, 0, moving);
      reordered.forEach(function (s, i) {
        patch[stopPath(day.id, s.id) + '/order'] = (i + 1) * Model.ORDER_STEP;
      });
    } else {
      patch[stopPath(day.id, moving.id) + '/order'] = order;
    }

    change(patch, { action: 'stop-move', summary: '把「' + moving.name + '」挪到第 ' + (to + 1) + ' 位' });
    render();
    if (M.isReady()) refreshLegs(true);
  }

  function removeStop(day, stop) {
    if (!confirm('删除「' + stop.name + '」？')) return;
    const p = {}; p[stopPath(day.id, stop.id)] = null;
    change(p, { action: 'stop-delete', summary: '删掉了「' + stop.name + '」' });
    render();
    if (M.isReady()) refreshLegs(true);
  }

  function cycleMode(day, stop) {
    const order = ['DRIVING', 'TRANSIT', 'WALKING', 'BICYCLING'];
    const next = order[(order.indexOf(stop.arriveMode || 'DRIVING') + 1) % order.length];
    const p = {}; p[stopPath(day.id, stop.id) + '/arriveMode'] = next;
    change(p, { action: 'stop-edit', summary: '去「' + stop.name + '」改成' + U.MODES[next].label });
    render();
    if (M.isReady()) refreshLegs(true);
  }

  /* ================= 地点编辑弹窗 ================= */
  let editing = null;   // {dayId, stopId}
  let autocompleteAttached = false;

  function attachDialogAutocomplete() {
    if (autocompleteAttached) return;
    const input = $('f-search');
    if (!input) return;
    const ac = M.attachAutocomplete(input, function (place) {
      $('f-name').value = place.name;
      $('f-address').value = place.address;
      $('f-lat').value = place.lat.toFixed(6);
      $('f-lng').value = place.lng.toFixed(6);
      const guessed = guessCategory(place.types);
      if (guessed) $('f-category').value = guessed;
      $('f-search').value = '';
    });
    autocompleteAttached = !!ac;
    if (ac) $('f-search').placeholder = '搜索地点（Google Places，自动带回坐标）';
  }

  function guessCategory(types) {
    if (!types) return null;
    if (types.indexOf('restaurant') >= 0 || types.indexOf('cafe') >= 0 || types.indexOf('food') >= 0 || types.indexOf('bakery') >= 0) return 'food';
    if (types.indexOf('lodging') >= 0) return 'hotel';
    if (types.indexOf('airport') >= 0 || types.indexOf('transit_station') >= 0) return 'transport';
    if (types.indexOf('shopping_mall') >= 0 || types.indexOf('store') >= 0) return 'shopping';
    if (types.indexOf('park') >= 0 || types.indexOf('natural_feature') >= 0) return 'outdoor';
    if (types.indexOf('tourist_attraction') >= 0 || types.indexOf('museum') >= 0) return 'attraction';
    return null;
  }

  function openStopDialog(day, stop) {
    editing = stop
      // 存一份打开那一刻的快照：保存时只写「你在表单里真正动过的字段」，
      // 这样同伴在你打开弹窗期间改的别的字段不会被你手里的旧值冲掉
      ? { dayId: day.id, stopId: stop.id, snapshot: JSON.parse(JSON.stringify(stop)) }
      : { dayId: day.id, stopId: null, snapshot: null };
    const s = stop || S.newStop();
    $('stopDialogTitle').textContent = stop ? '编辑地点' : '添加地点';
    $('f-search').value = '';
    $('f-name').value = s.name;
    $('f-category').value = s.category;
    $('f-address').value = s.address || '';
    $('f-lat').value = s.lat == null ? '' : s.lat;
    $('f-lng').value = s.lng == null ? '' : s.lng;
    $('f-stay').value = s.stayMin;
    $('f-mode').value = s.arriveMode || 'DRIVING';
    $('f-fixed').value = s.fixedStart || '';
    $('f-notes').value = s.notes || '';
    attachDialogAutocomplete();
    if (stop) Sync.setEditing(stop.id);
    $('stopDialog').showModal();
  }

  function closeStopDialog() {
    Sync.setEditing(null);
    editing = null;
    $('stopDialog').close();
  }

  function saveStopDialog(e) {
    e.preventDefault();
    const day = Model.dayList(state.trip).filter(function (d) { return d.id === editing.dayId; })[0];
    if (!day) { closeStopDialog(); return; }

    const lat = parseFloat($('f-lat').value);
    const lng = parseFloat($('f-lng').value);
    const data = {
      name: $('f-name').value.trim() || '未命名地点',
      category: $('f-category').value,
      address: $('f-address').value.trim(),
      lat: isNaN(lat) ? null : lat,
      lng: isNaN(lng) ? null : lng,
      stayMin: Math.max(0, parseInt($('f-stay').value, 10) || 0),
      arriveMode: $('f-mode').value,
      fixedStart: $('f-fixed').value || '',
      notes: $('f-notes').value.trim(),
      updatedBy: Sync.myName(),
      updatedAt: Date.now()
    };

    const patch = {};
    let meta;
    if (editing.stopId && day.stops[editing.stopId]) {
      // 只写真正改动的字段：撤销时能精确还原，两个人同时改同一个地点的不同字段也不会互相覆盖。
      // 比较的基准是「打开弹窗那一刻」的快照，不是当前值——否则同伴刚改的字段会被表单里的旧值覆盖回去。
      const existing = day.stops[editing.stopId];
      const base = editing.snapshot || existing;
      const same = function (a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); };
      const changed = Object.keys(data).filter(function (k) {
        return k !== 'updatedAt' && k !== 'updatedBy' && !same(base[k], data[k]);
      });
      if (!changed.length) { render(); return; }          // 什么都没改，不留记录
      changed.concat(['updatedAt', 'updatedBy']).forEach(function (k) {
        patch[stopPath(day.id, existing.id) + '/' + k] = data[k];
      });
      meta = { action: 'stop-edit', summary: describeEdit(base, Object.assign({}, base, data)) };
    } else {
      const stop = S.newStop(data, Model.nextOrder(day.stops));
      patch[stopPath(day.id, stop.id)] = stop;
      meta = { action: 'stop-add', summary: '加了新地点「' + stop.name + '」' };
    }

    closeStopDialog();
    change(patch, meta);
    render();
    if (M.isReady()) refreshLegs(true);
  }

  /** 对比新旧地点，说人话地描述改了什么 */
  function describeEdit(before, after) {
    const parts = [];
    if (before.name !== after.name) parts.push('改名为「' + after.name + '」');
    if ((before.stayMin || 0) !== (after.stayMin || 0)) parts.push('停留改成 ' + U.toDuration(after.stayMin));
    if ((before.arriveMode || '') !== (after.arriveMode || '')) parts.push('改成' + (U.MODES[after.arriveMode] || {}).label + '过去');
    if ((before.fixedStart || '') !== (after.fixedStart || '')) {
      parts.push(after.fixedStart ? '固定时间设为 ' + after.fixedStart : '取消了固定时间');
    }
    if ((before.category || '') !== (after.category || '')) parts.push('类型改成' + (U.CATEGORIES[after.category] || {}).label);
    if ((before.notes || '') !== (after.notes || '')) parts.push('改了备注');
    if ((before.lat !== after.lat) || (before.lng !== after.lng)) parts.push('换了位置');
    if (!parts.length) return '编辑了「' + before.name + '」';
    return '「' + before.name + '」' + parts.join('、');
  }

  /* ================= 顶部操作 ================= */
  function bindControls() {
    $('tripTitle').addEventListener('change', function (e) {
      change({ title: e.target.value }, { action: 'title', summary: '把行程改名为「' + e.target.value + '」' });
    });

    $('addStopBtn').addEventListener('click', function () {
      const day = currentDay();
      if (!day) { addDay(); return; }
      openStopDialog(day, null);
    });
    $('stopForm').addEventListener('submit', saveStopDialog);
    $('stopCancel').addEventListener('click', closeStopDialog);
    $('stopDialog').addEventListener('close', function () { Sync.setEditing(null); });

    // 下拉菜单
    const menu = $('menu');
    $('menuBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      $('menuBtn').setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('click', function () { menu.hidden = true; });
    menu.addEventListener('click', function () { menu.hidden = true; });

    $('historyBtn').addEventListener('click', openHistory);
    $('historyClose').addEventListener('click', function () { $('historyDialog').close(); });
    $('historyMineBtn').addEventListener('click', function () {
      historyFilterMine = !historyFilterMine;
      renderHistory();
    });
    $('undoBtn').addEventListener('click', undoMyLast);

    // Ctrl/Cmd + Z 撤销自己最近一次改动
    document.addEventListener('keydown', function (e) {
      const key = (e.key || '').toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === 'z' && !e.shiftKey) {
        const ae = document.activeElement;
        if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) return;   // 输入框里让浏览器自己撤销文字
        e.preventDefault();
        undoMyLast();
      }
    });

    // 拖拽排序（手机长按手柄拖动，桌面鼠标拖动）
    global.DragSort.attach({
      container: $('timeline'),
      itemSelector: '.stop',
      handleSelector: '.drag-handle',
      onDrop: function (from, to) {
        const day = currentDay();
        if (day) moveStopTo(day, from, to);
      }
    });

    $('refreshBtn').addEventListener('click', function () {
      if (!M.isReady()) { toast('需要先填 Google Maps API Key'); return; }
      refreshLegs(false);
    });
    $('copyBtn').addEventListener('click', copyDayText);
    $('exportBtn').addEventListener('click', exportTrip);
    $('importInput').addEventListener('change', importTrip);
    $('sampleBtn').addEventListener('click', function () {
      if (!confirm('用示例行程覆盖当前行程？同伴那边也会一起变（可以在修改记录里撤销）。')) return;
      replaceTrip(S.sampleTrip(), { action: 'replace', summary: '载入了示例行程' });
    });
    $('newTripBtn').addEventListener('click', function () {
      if (!confirm('新建一个空行程？当前这份还留在原来的链接里，随时能回去。')) return;
      const id = Model.newTripId();
      localStorage.setItem(LAST_TRIP_KEY, id);
      location.href = location.pathname + '?trip=' + id;
    });

    // 邀请
    $('shareBtn').addEventListener('click', openShare);
    $('shareClose').addEventListener('click', function () { $('shareDialog').close(); });
    $('shareCopy').addEventListener('click', function () {
      const link = $('shareLink').value;
      navigator.clipboard.writeText(link).then(function () { toast('链接已复制，发给朋友就行'); },
        function () { $('shareLink').select(); });
    });
    $('shareSystem').addEventListener('click', function () {
      const link = $('shareLink').value;
      if (navigator.share) navigator.share({ title: state.trip.title || '我的行程', url: link }).catch(function () {});
      else toast('这个浏览器不支持系统分享，用「复制链接」吧');
    });

    // 设置
    $('settingsBtn').addEventListener('click', openSettings);
    $('settingsCancel').addEventListener('click', function () { $('settingsDialog').close(); });
    $('settingsClear').addEventListener('click', function () {
      if (!confirm('清除这台设备上手填的 Key / Firebase 配置？')) return;
      Config.clearLocal();
      location.reload();
    });
    $('settingsForm').addEventListener('submit', saveSettings);
  }

  function bindMobileTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('.mobile-tab'), function (btn) {
      btn.addEventListener('click', function () {
        const view = btn.getAttribute('data-view');
        $('layout').setAttribute('data-view', view);
        Array.prototype.forEach.call(document.querySelectorAll('.mobile-tab'), function (b) {
          b.classList.toggle('is-active', b === btn);
        });
        // 地图在隐藏状态下初始化过，切回来要让它重新量尺寸
        if (view === 'map' && M.isReady()) setTimeout(M.resize, 60);
      });
    });
  }

  /* ================= 邀请 / 设置 ================= */
  function openShare() {
    const link = location.origin + location.pathname + '?trip=' + state.tripId + Config.shareSuffix();
    $('shareLink').value = link;

    const mode = Sync.getMode();
    const hint = {
      local: '⚠️ 还没配 Firebase，现在这条链接只能打开同一份「本机行程」，改动不会互通。到「⚙️ 设置」里粘贴 Firebase 配置后即可实时协作。',
      connecting: '正在连接协作服务…',
      online: '✅ 已连上协作服务。拿到链接的人打开就能一起看、一起改，谁改了大家立刻看到。',
      offline: '📴 当前离线。链接照发，等你联网后改动会补传上去。',
      error: '⚠️ 协作服务连接失败，链接暂时只是本机行程。'
    }[mode] || '';
    $('shareHint').textContent = hint;

    const members = $('shareMembers');
    members.innerHTML = '';
    const me = Sync.getMe();
    const all = (me && mode !== 'local' ? [{ name: me.name + '（我）', color: me.color }] : []).concat(state.presence);
    if (all.length) {
      members.appendChild(U.el('div', { class: 'members-title', text: '现在在线（' + all.length + '）' }));
      all.forEach(function (p) {
        members.appendChild(U.el('div', { class: 'member' }, [
          U.el('span', { class: 'avatar', style: 'background:' + (p.color || '#64748b'), text: U.initials(p.name) }),
          U.el('span', { text: p.name || '匿名' })
        ]));
      });
    }
    $('shareDialog').showModal();
  }

  function openSettings() {
    const cfg = Config.load();
    $('f-nick').value = Sync.myName();
    $('f-key').value = cfg.mapsApiKey || '';
    $('f-fb').value = cfg.firebase && cfg.firebase.apiKey ? JSON.stringify(cfg.firebase, null, 2) : '';
    const src = Config.getSource();
    $('configSource').textContent = {
      deploy: '当前配置来自部署时注入（部署环境已内置 Key，朋友打开链接即用）。',
      local: '当前配置存在这台设备上。',
      none: '当前没有任何配置：地图和协作都不可用，时间轴仍可正常使用。'
    }[src];
    $('settingsDialog').showModal();
  }

  function saveSettings(e) {
    e.preventDefault();
    Sync.setName($('f-nick').value);

    let firebase = null;
    const raw = $('f-fb').value.trim();
    if (raw) {
      try {
        firebase = JSON.parse(raw.replace(/^\s*(const|var|let)?\s*firebaseConfig\s*=\s*/, '').replace(/;\s*$/, ''));
      } catch (err) {
        alert('Firebase 配置解析失败，请粘贴完整的 JSON 对象：\n' + err.message);
        return;
      }
      if (!firebase.databaseURL) {
        alert('缺少 databaseURL。请在 Firebase 控制台创建 Realtime Database，再复制一次配置。');
        return;
      }
    }

    Config.save({ mapsApiKey: $('f-key').value.trim(), firebase: firebase || {} });
    $('settingsDialog').close();
    location.reload();
  }

  /* ================= 路程 / 导入导出 ================= */
  function refreshLegs(silent) {
    const day = currentDay();
    if (!day) return Promise.resolve();
    const status = $('mapStatus');
    status.textContent = '正在向 Google 查询路程时间…';
    status.hidden = false;
    return M.fetchLegs(Model.stopList(day), function (done, total) {
      status.textContent = '正在查询路程时间 ' + done + '/' + total + '…';
    }).then(function (count) {
      render();
      if (count > 0) {
        status.textContent = '已更新 ' + count + ' 段真实路程时间';
        setTimeout(function () { status.hidden = true; }, 2500);
      } else if (silent) {
        status.hidden = true;
      } else {
        status.textContent = '所有路段都已有缓存（改顺序或交通方式后会自动重算）';
        setTimeout(function () { status.hidden = true; }, 2500);
      }
    }).catch(function (err) {
      console.error(err);
      status.textContent = '查询路程失败：' + err.message;
    });
  }

  function exportTrip() {
    const blob = new Blob([JSON.stringify(Model.toPlain(state.trip), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.trip.title || 'trip') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function importTrip(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !parsed.days) throw new Error('格式不对，缺少 days');
        replaceTrip(parsed, { action: 'replace', summary: '导入了行程文件「' + file.name + '」' });
        toast('已导入（可在修改记录里撤销）');
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function copyDayText() {
    const day = currentDay();
    if (!day || !state.schedule) return;
    const lines = [];
    lines.push('【' + U.formatDate(day.date) + ' ' + day.title + '】');
    state.schedule.items.forEach(function (item, i) {
      const cat = U.CATEGORIES[item.stop.category] || U.CATEGORIES.other;
      if (item.leg) {
        const mode = U.MODES[item.leg.mode] || U.MODES.DRIVING;
        lines.push('   ↓ ' + U.toClock(item.leg.departAt) + ' 出门，' + mode.label + ' ' +
          U.toDuration(item.leg.minutes) + (item.leg.km != null ? '（' + item.leg.km + ' km）' : ''));
      }
      lines.push((i + 1) + '. ' + U.toClock(item.startAt) + '–' + U.toClock(item.departAt) + ' ' +
        cat.icon + ' ' + item.stop.name + '（停留 ' + U.toDuration(item.stayMin) + '）' +
        (item.lateBy > 0 ? ' ⚠️赶不上预约' : ''));
    });
    const sum = state.schedule.summary;
    lines.push('合计：游玩 ' + U.toDuration(sum.totalStay) + ' · 路上 ' + U.toDuration(sum.totalTravel) + ' · ' + (sum.totalKm || 0) + ' km');
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(function () { toast('当天行程已复制'); },
      function () { prompt('复制下面的文字：', text); });
  }

  /* ================= 杂项 UI ================= */
  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function showMapNotice(text, withButton) {
    const n = $('mapNotice');
    n.innerHTML = '';
    n.appendChild(U.el('p', { text: text }));
    if (withButton) {
      n.appendChild(U.el('button', { class: 'primary-btn', text: '去设置', onclick: openSettings }));
      n.appendChild(U.el('p', { class: 'notice-hint', html: '在 <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener">Google Cloud Console</a> 建 Key，启用 Maps JavaScript API、Directions API、Places API。' }));
    }
    n.hidden = false;
  }

  function hideMapNotice() { $('mapNotice').hidden = true; }

  /* ================= PWA：装到桌面 + 自动更新 ================= */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;

    navigator.serviceWorker.register('sw.js').then(function (reg) {
      // 有新版本就装上，装好后自动切过去
      reg.addEventListener('updatefound', function () {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('发现新版本，正在更新…');
            sw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
      // 每次回到前台检查一次更新
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) reg.update().catch(function () {});
      });
      setInterval(function () { reg.update().catch(function () {}); }, 30 * 60 * 1000);
    }).catch(function (err) {
      console.warn('Service Worker 注册失败', err);
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})(window);
