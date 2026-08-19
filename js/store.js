/* 数据存储：行程存在浏览器 localStorage，支持导入 / 导出 JSON。 */
(function (global) {
  'use strict';

  const TRIP_KEY = 'us-routine.trip.v1';
  const KEY_KEY = 'us-routine.gmaps-key';
  const LEG_KEY = 'us-routine.leg-cache.v1';
  const U = global.Util;

  function loadTrip() {
    try {
      const raw = localStorage.getItem(TRIP_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.days)) return parsed;
      }
    } catch (e) {
      console.warn('读取本地行程失败，回退到示例行程', e);
    }
    return JSON.parse(JSON.stringify(global.SampleTrip));
  }

  function saveTrip(trip) {
    try {
      localStorage.setItem(TRIP_KEY, JSON.stringify(trip));
    } catch (e) {
      console.warn('保存行程失败', e);
    }
  }

  function resetTrip() {
    localStorage.removeItem(TRIP_KEY);
    return JSON.parse(JSON.stringify(global.SampleTrip));
  }

  function getApiKey() {
    return localStorage.getItem(KEY_KEY) || '';
  }

  function setApiKey(key) {
    if (key) localStorage.setItem(KEY_KEY, key.trim());
    else localStorage.removeItem(KEY_KEY);
  }

  /* ---- 路段耗时缓存：省 Directions API 配额 ---- */
  let legCache = {};
  try {
    legCache = JSON.parse(localStorage.getItem(LEG_KEY) || '{}');
  } catch (e) {
    legCache = {};
  }

  function legKey(from, to, mode) {
    const r = function (n) { return n == null ? 'x' : Number(n).toFixed(4); };
    return mode + '|' + r(from.lat) + ',' + r(from.lng) + '>' + r(to.lat) + ',' + r(to.lng);
  }

  function getLeg(from, to, mode) {
    if (!from || !to) return null;
    return legCache[legKey(from, to, mode)] || null;
  }

  function putLeg(from, to, mode, value) {
    legCache[legKey(from, to, mode)] = value;
    try {
      localStorage.setItem(LEG_KEY, JSON.stringify(legCache));
    } catch (e) { /* 配额满就算了，内存里还在 */ }
  }

  function clearLegCache() {
    legCache = {};
    localStorage.removeItem(LEG_KEY);
  }

  /* ---- 行程结构操作 ---- */
  function newStop(partial) {
    return Object.assign({
      id: U.uid('stop'),
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

  function newDay(index) {
    const base = new Date();
    base.setDate(base.getDate() + (index || 0));
    return {
      id: U.uid('day'),
      date: base.toISOString().slice(0, 10),
      title: '第 ' + ((index || 0) + 1) + ' 天',
      startTime: '09:00',
      stops: []
    };
  }

  global.Store = {
    loadTrip: loadTrip,
    saveTrip: saveTrip,
    resetTrip: resetTrip,
    getApiKey: getApiKey,
    setApiKey: setApiKey,
    getLeg: getLeg,
    putLeg: putLeg,
    clearLegCache: clearLegCache,
    newStop: newStop,
    newDay: newDay
  };
})(window);
