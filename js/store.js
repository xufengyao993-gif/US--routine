/* 本地存储：行程缓存、路段耗时缓存、行程 ID */
(function (global) {
  'use strict';

  const TRIP_KEY = 'us-routine.trip.v2';
  const LEG_KEY = 'us-routine.leg-cache.v1';
  const U = global.Util;
  const Model = global.Model;

  /* ---------- 行程 ---------- */
  /** 每个行程 ID 一份本地缓存，换行程不会串味 */
  function tripKey(tripId) {
    return TRIP_KEY + (tripId ? ':' + tripId : '');
  }

  function loadTrip(tripId) {
    const keys = [tripKey(tripId)];
    if (!tripId) keys.push('us-routine.trip.v1');   // 兼容第一版的旧数据
    for (let i = 0; i < keys.length; i++) {
      try {
        const raw = localStorage.getItem(keys[i]);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.days) return Model.migrate(parsed);
      } catch (e) {
        console.warn('读取本地行程失败', e);
      }
    }
    return null;
  }

  function saveTrip(trip, tripId) {
    try {
      localStorage.setItem(tripKey(tripId), JSON.stringify(trip));
    } catch (e) {
      console.warn('保存行程失败', e);
    }
  }

  function sampleTrip() {
    return Model.migrate(JSON.parse(JSON.stringify(global.SampleTrip)));
  }

  function clearTrip(tripId) {
    localStorage.removeItem(tripKey(tripId));
  }

  /* ---------- 修改记录（本地镜像，离线也看得到） ---------- */
  const HISTORY_KEY = 'us-routine.history';

  function historyKey(tripId) { return HISTORY_KEY + (tripId ? ':' + tripId : ''); }

  function loadHistory(tripId) {
    try {
      const raw = localStorage.getItem(historyKey(tripId));
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory(tripId, list) {
    try {
      localStorage.setItem(historyKey(tripId), JSON.stringify(list));
    } catch (e) { /* 满了就算了，云端还有 */ }
  }

  /* ---------- 路段耗时缓存（省 Directions 配额） ---------- */
  let legCache = {};
  try {
    legCache = JSON.parse(localStorage.getItem(LEG_KEY) || '{}');
  } catch (e) {
    legCache = {};
  }

  // 不同地图服务算出来的耗时和路线格式都不一样，缓存要分开放
  let provider = 'osm';
  function setProvider(name) { provider = name || 'osm'; }

  function legKey(from, to, mode) {
    const r = function (n) { return n == null ? 'x' : Number(n).toFixed(4); };
    return provider + '|' + mode + '|' + r(from.lat) + ',' + r(from.lng) + '>' + r(to.lat) + ',' + r(to.lng);
  }

  function getLeg(from, to, mode) {
    if (!from || !to) return null;
    return legCache[legKey(from, to, mode)] || null;
  }

  function putLeg(from, to, mode, value) {
    legCache[legKey(from, to, mode)] = value;
    try {
      localStorage.setItem(LEG_KEY, JSON.stringify(legCache));
    } catch (e) { /* 配额满就只留在内存 */ }
  }

  /* ---------- 新建对象 ---------- */
  function newStop(partial, order) {
    return Object.assign({
      id: U.uid('stop'),
      order: order || Model.ORDER_STEP,
      name: '新地点',
      category: 'attraction',
      address: '',
      lat: null,
      lng: null,
      stayMin: 60,
      arriveMode: 'DRIVING',
      fixedStart: '',
      notes: ''
    }, partial || {});
  }

  function newDay(index, order) {
    return {
      id: U.uid('day'),
      order: order || (((index || 0) + 1) * Model.ORDER_STEP),
      date: U.addDays(null, index || 0),
      title: '第 ' + ((index || 0) + 1) + ' 天',
      startTime: '09:00',
      stops: {}
    };
  }

  global.Store = {
    loadTrip: loadTrip,
    saveTrip: saveTrip,
    clearTrip: clearTrip,
    sampleTrip: sampleTrip,
    loadHistory: loadHistory,
    saveHistory: saveHistory,
    setProvider: setProvider,
    getLeg: getLeg,
    putLeg: putLeg,
    newStop: newStop,
    newDay: newDay
  };
})(window);
