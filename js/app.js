/* 界面与交互 */
(function (global) {
  'use strict';

  const U = global.Util;
  const S = global.Store;
  const M = global.Maps;

  let trip = null;
  let activeDayIndex = 0;
  let activeStopId = null;
  let currentSchedule = null;

  const $ = function (id) { return document.getElementById(id); };

  /* ---------------- 启动 ---------------- */
  function boot() {
    trip = S.loadTrip();
    bindGlobalControls();
    render();
    const key = S.getApiKey();
    if (key) startMaps(key);
    else showMapNotice('还没填 Google Maps API Key。时间轴照常可用（路程为估算值），填上 Key 后就能看到地图打点、连线和真实路况耗时。', true);
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

  /* ---------------- 渲染 ---------------- */
  function render() {
    renderDayTabs();
    const day = trip.days[activeDayIndex];
    if (!day) {
      $('timeline').innerHTML = '<div class="empty">还没有行程，点上面的「+ 新的一天」开始。</div>';
      $('dayMeta').innerHTML = '';
      return;
    }
    currentSchedule = global.Schedule.computeDay(day, function (from, to, mode) {
      return S.getLeg(from, to, mode);
    });
    renderDayMeta(day, currentSchedule.summary);
    renderTimeline(day, currentSchedule.items);
    if (M.isReady()) {
      M.renderDay(day, currentSchedule.items, {
        activeStopId: activeStopId,
        onMarkerClick: function (id) {
          activeStopId = id;
          renderTimeline(day, currentSchedule.items);
          const card = document.querySelector('[data-stop-card="' + id + '"]');
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }
  }

  function renderDayTabs() {
    const wrap = $('dayTabs');
    wrap.innerHTML = '';
    trip.days.forEach(function (day, i) {
      wrap.appendChild(U.el('button', {
        class: 'daytab' + (i === activeDayIndex ? ' is-active' : ''),
        onclick: function () {
          activeDayIndex = i;
          activeStopId = null;
          render();
          if (M.isReady()) refreshLegs(true);
        }
      }, [
        U.el('span', { class: 'daytab-day', text: 'Day ' + (i + 1) }),
        U.el('span', { class: 'daytab-date', text: U.formatDate(day.date) })
      ]));
    });
    wrap.appendChild(U.el('button', {
      class: 'daytab daytab-add', text: '+ 新的一天',
      onclick: addDay
    }));
  }

  function renderDayMeta(day, sum) {
    const meta = $('dayMeta');
    meta.innerHTML = '';
    meta.appendChild(U.el('div', { class: 'day-title-row' }, [
      U.el('input', {
        class: 'day-title', value: day.title, placeholder: '这一天叫什么',
        onchange: function (e) { day.title = e.target.value; persist(); renderDayTabs(); }
      }),
      U.el('button', { class: 'icon-btn', title: '删除这一天', text: '🗑', onclick: removeDay })
    ]));

    meta.appendChild(U.el('div', { class: 'day-inputs' }, [
      U.el('label', {}, [
        U.el('span', { text: '日期' }),
        U.el('input', {
          type: 'date', value: day.date,
          onchange: function (e) { day.date = e.target.value; persist(); renderDayTabs(); }
        })
      ]),
      U.el('label', {}, [
        U.el('span', { text: '当天出发' }),
        U.el('input', {
          type: 'time', value: day.startTime,
          onchange: function (e) { day.startTime = e.target.value || '09:00'; persist(); render(); }
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
    const strip = U.el('div', { class: 'summary' }, chips.map(function (c) {
      return U.el('div', { class: 'summary-chip' }, [
        U.el('span', { class: 'summary-label', text: c[0] }),
        U.el('span', { class: 'summary-value', text: c[1] })
      ]);
    }));
    meta.appendChild(strip);

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
    tl.innerHTML = '';
    if (!items.length) {
      tl.appendChild(U.el('div', { class: 'empty', text: '这一天还是空的，点下面「+ 添加地点」。' }));
      return;
    }

    items.forEach(function (item, i) {
      if (item.leg) tl.appendChild(renderLeg(item, items[i - 1]));
      tl.appendChild(renderStopCard(day, item, i, items.length));
    });
  }

  function renderLeg(item, prevItem) {
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
        text: isFood ? '🍜 导航去吃饭' : '🧭 打开 Google 导航'
      }),
      U.el('button', {
        class: 'link-btn ghost',
        text: '换交通方式',
        onclick: function () { cycleMode(item.stop); }
      })
    ]));

    return U.el('div', { class: 'leg' + (isFood ? ' leg-food' : '') + (late ? ' leg-late' : '') }, rows);
  }

  function renderStopCard(day, item, i, total) {
    const stop = item.stop;
    const cat = U.CATEGORIES[stop.category] || U.CATEGORIES.other;
    const active = activeStopId === stop.id;

    const badges = [];
    if (item.isFixed) badges.push(U.el('span', { class: 'badge badge-fixed', text: '固定 ' + stop.fixedStart }));
    if (item.waitMin > 0) badges.push(U.el('span', { class: 'badge badge-wait', text: '空档 ' + U.toDuration(item.waitMin) }));
    if (item.lateBy > 0) badges.push(U.el('span', { class: 'badge badge-late', text: '迟到 ' + U.toDuration(item.lateBy) }));
    if (stop.lat == null) badges.push(U.el('span', { class: 'badge badge-muted', text: '缺坐标' }));

    return U.el('div', {
      class: 'stop' + (active ? ' is-active' : ''),
      'data-stop-card': stop.id,
      style: '--cat-color:' + cat.color,
      onclick: function () {
        activeStopId = stop.id;
        renderTimeline(day, currentSchedule.items);
        if (M.isReady()) {
          M.focusStop(stop);
          M.renderDay(day, currentSchedule.items, { activeStopId: activeStopId, keepViewport: true });
        }
      }
    }, [
      U.el('div', { class: 'stop-num', text: String(i + 1) }),
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
          U.el('button', { class: 'link-btn ghost', text: '编辑', onclick: function (e) { e.stopPropagation(); openStopDialog(stop); } }),
          U.el('button', { class: 'link-btn ghost', text: '↑', title: '上移', disabled: i === 0 ? 'disabled' : null, onclick: function (e) { e.stopPropagation(); moveStop(i, -1); } }),
          U.el('button', { class: 'link-btn ghost', text: '↓', title: '下移', disabled: i === total - 1 ? 'disabled' : null, onclick: function (e) { e.stopPropagation(); moveStop(i, 1); } }),
          U.el('button', { class: 'link-btn ghost danger', text: '删除', onclick: function (e) { e.stopPropagation(); removeStop(i); } })
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

  /* ---------------- 行程编辑 ---------------- */
  function persist() { S.saveTrip(trip); }

  function currentDay() { return trip.days[activeDayIndex]; }

  function addDay() {
    const d = S.newDay(trip.days.length);
    const prev = trip.days[trip.days.length - 1];
    if (prev && prev.date) {
      const nd = new Date(prev.date + 'T00:00:00');
      nd.setDate(nd.getDate() + 1);
      d.date = nd.toISOString().slice(0, 10);
    }
    trip.days.push(d);
    activeDayIndex = trip.days.length - 1;
    persist();
    render();
  }

  function removeDay() {
    if (!confirm('删除这一天的全部行程？')) return;
    trip.days.splice(activeDayIndex, 1);
    if (!trip.days.length) trip.days.push(S.newDay(0));
    activeDayIndex = Math.max(0, activeDayIndex - 1);
    persist();
    render();
  }

  function moveStop(i, delta) {
    const stops = currentDay().stops;
    const j = i + delta;
    if (j < 0 || j >= stops.length) return;
    const tmp = stops[i];
    stops[i] = stops[j];
    stops[j] = tmp;
    persist();
    render();
    if (M.isReady()) refreshLegs(true);
  }

  function removeStop(i) {
    const stops = currentDay().stops;
    if (!confirm('删除「' + stops[i].name + '」？')) return;
    stops.splice(i, 1);
    persist();
    render();
    if (M.isReady()) refreshLegs(true);
  }

  function cycleMode(stop) {
    const order = ['DRIVING', 'TRANSIT', 'WALKING', 'BICYCLING'];
    const idx = order.indexOf(stop.arriveMode || 'DRIVING');
    stop.arriveMode = order[(idx + 1) % order.length];
    persist();
    render();
    if (M.isReady()) refreshLegs(true);
  }

  /* ---------------- 地点编辑弹窗 ---------------- */
  let editingStop = null;
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

  function openStopDialog(stop) {
    editingStop = stop || null;
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
    $('stopDialog').showModal();
  }

  function saveStopDialog(e) {
    e.preventDefault();
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
      fixedStart: $('f-fixed').value,
      notes: $('f-notes').value.trim()
    };
    if (editingStop) {
      Object.assign(editingStop, data);
    } else {
      currentDay().stops.push(S.newStop(data));
    }
    editingStop = null;
    $('stopDialog').close();
    persist();
    render();
    if (M.isReady()) refreshLegs(true);
  }

  /* ---------------- 顶部操作 ---------------- */
  function bindGlobalControls() {
    $('tripTitle').value = trip.title || '我的美国行程';
    $('tripTitle').addEventListener('change', function (e) {
      trip.title = e.target.value;
      persist();
    });

    $('addStopBtn').addEventListener('click', function () { openStopDialog(null); });
    $('stopForm').addEventListener('submit', saveStopDialog);
    $('stopCancel').addEventListener('click', function () { $('stopDialog').close(); });

    $('refreshBtn').addEventListener('click', function () {
      if (!M.isReady()) {
        alert('需要先填 Google Maps API Key 才能拿真实路程时间。');
        return;
      }
      refreshLegs(false);
    });

    $('keyBtn').addEventListener('click', function () {
      $('f-key').value = S.getApiKey();
      $('keyDialog').showModal();
    });
    $('keyForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const key = $('f-key').value.trim();
      S.setApiKey(key);
      $('keyDialog').close();
      if (key) location.reload();
    });
    $('keyCancel').addEventListener('click', function () { $('keyDialog').close(); });

    $('exportBtn').addEventListener('click', exportTrip);
    $('importInput').addEventListener('change', importTrip);
    $('copyBtn').addEventListener('click', copyDayText);
    $('resetBtn').addEventListener('click', function () {
      if (!confirm('恢复成示例行程？当前编辑会丢失。')) return;
      trip = S.resetTrip();
      activeDayIndex = 0;
      persist();
      render();
    });
  }

  function refreshLegs(silent) {
    const day = currentDay();
    if (!day) return Promise.resolve();
    const status = $('mapStatus');
    status.textContent = '正在向 Google 查询路程时间…';
    status.hidden = false;
    return M.fetchLegs(day, function (done, total) {
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
    const blob = new Blob([JSON.stringify(trip, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (trip.title || 'trip') + '.json';
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
        if (!parsed || !Array.isArray(parsed.days)) throw new Error('格式不对，缺少 days 数组');
        trip = parsed;
        activeDayIndex = 0;
        activeStopId = null;
        persist();
        render();
        if (M.isReady()) refreshLegs(true);
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  /** 把当天行程导成一段可以直接发给同伴的文字 */
  function copyDayText() {
    const day = currentDay();
    if (!day || !currentSchedule) return;
    const lines = [];
    lines.push('【' + U.formatDate(day.date) + ' ' + day.title + '】');
    currentSchedule.items.forEach(function (item, i) {
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
    const sum = currentSchedule.summary;
    lines.push('合计：游玩 ' + U.toDuration(sum.totalStay) + ' · 路上 ' + U.toDuration(sum.totalTravel) +
      ' · ' + (sum.totalKm || 0) + ' km');
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(function () {
      const status = $('mapStatus');
      status.textContent = '当天行程已复制到剪贴板';
      status.hidden = false;
      setTimeout(function () { status.hidden = true; }, 2000);
    }, function () {
      prompt('复制下面的文字：', text);
    });
  }

  /* ---------------- 地图提示 ---------------- */
  function showMapNotice(text, withButton) {
    const n = $('mapNotice');
    n.innerHTML = '';
    n.appendChild(U.el('p', { text: text }));
    if (withButton) {
      n.appendChild(U.el('button', {
        class: 'primary-btn', text: '填写 API Key',
        onclick: function () { $('f-key').value = S.getApiKey(); $('keyDialog').showModal(); }
      }));
      n.appendChild(U.el('p', { class: 'notice-hint', html: '在 <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener">Google Cloud Console</a> 建一个 Key，启用 Maps JavaScript API、Directions API、Places API。' }));
    }
    n.hidden = false;
  }

  function hideMapNotice() { $('mapNotice').hidden = true; }

  document.addEventListener('DOMContentLoaded', boot);
})(window);
