/*
 * 天气：Open-Meteo（免费、不用注册、不用 Key、CORS 直连）。
 *
 * 按目标日期离今天多远，走三条不同的路：
 *   过去   -> 实测数据（archive）
 *   16 天内 -> 逐小时预报，能对应到「几点在哪个地点」
 *   更远    -> 往年同期实测的平均值，只能当参考，界面上必须标明不是预报
 *
 * 结果按「地点 + 日期」缓存：预报缓存 3 小时，历史同期缓存 30 天。
 */
(function (global) {
  'use strict';

  const FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
  const CACHE_KEY = 'us-routine.weather.v1';
  const FORECAST_TTL = 3 * 60 * 60 * 1000;
  const NORMALS_TTL = 30 * 24 * 60 * 60 * 1000;
  const FORECAST_DAYS = 15;      // Open-Meteo 免费档能给到 16 天，留一天余量
  const PAST_DAYS = 5;           // 实测数据有几天延迟
  const NORMAL_YEARS = 3;        // 往年同期取几年平均

  /* ---------- WMO 天气代码 ---------- */
  const CODES = {
    0:  { icon: '☀️', label: '晴', rank: 0 },
    1:  { icon: '🌤️', label: '大致晴', rank: 1 },
    2:  { icon: '⛅', label: '多云', rank: 2 },
    3:  { icon: '☁️', label: '阴', rank: 3 },
    45: { icon: '🌫️', label: '雾', rank: 4 },
    48: { icon: '🌫️', label: '雾凇', rank: 4 },
    51: { icon: '🌦️', label: '毛毛雨', rank: 5 },
    53: { icon: '🌦️', label: '毛毛雨', rank: 5 },
    55: { icon: '🌦️', label: '毛毛雨', rank: 6 },
    56: { icon: '🌧️', label: '冻雨', rank: 7 },
    57: { icon: '🌧️', label: '冻雨', rank: 7 },
    61: { icon: '🌦️', label: '小雨', rank: 6 },
    63: { icon: '🌧️', label: '中雨', rank: 8 },
    65: { icon: '🌧️', label: '大雨', rank: 9 },
    66: { icon: '🌧️', label: '冻雨', rank: 8 },
    67: { icon: '🌧️', label: '冻雨', rank: 9 },
    71: { icon: '🌨️', label: '小雪', rank: 6 },
    73: { icon: '🌨️', label: '中雪', rank: 8 },
    75: { icon: '❄️', label: '大雪', rank: 9 },
    77: { icon: '🌨️', label: '雪粒', rank: 6 },
    80: { icon: '🌦️', label: '阵雨', rank: 6 },
    81: { icon: '🌧️', label: '阵雨', rank: 8 },
    82: { icon: '🌧️', label: '强阵雨', rank: 10 },
    85: { icon: '🌨️', label: '阵雪', rank: 7 },
    86: { icon: '❄️', label: '强阵雪', rank: 9 },
    95: { icon: '⛈️', label: '雷阵雨', rank: 11 },
    96: { icon: '⛈️', label: '雷暴伴冰雹', rank: 12 },
    99: { icon: '⛈️', label: '雷暴伴冰雹', rank: 12 }
  };

  function describe(code) {
    return CODES[code] || { icon: '🌡️', label: '', rank: 0 };
  }

  /** 一串小时里最「糟」的那种天气（用来给一段时间下结论） */
  function worstCode(codes) {
    let worst = null;
    (codes || []).forEach(function (c) {
      if (c == null) return;
      if (worst == null || describe(c).rank > describe(worst).rank) worst = c;
    });
    return worst;
  }

  /**
   * 从逐小时数据里截出一段时间的结论。
   * @param {Object} hourly {hours:[0..23], temp:[], precip:[], code:[]}
   * @param {number} startMin 当天 0 点起的分钟
   * @param {number} endMin
   */
  function slice(hourly, startMin, endMin) {
    if (!hourly || !hourly.hours || !hourly.hours.length) return null;
    const from = Math.max(0, Math.min(23, Math.floor(startMin / 60)));
    const to = Math.max(from, Math.min(23, Math.ceil((endMin || startMin) / 60) - 1));

    const temps = [];
    const precips = [];
    const codes = [];
    const rainHours = [];

    for (let h = from; h <= to; h++) {
      const i = hourly.hours.indexOf(h);
      if (i < 0) continue;
      if (hourly.temp[i] != null) temps.push(hourly.temp[i]);
      if (hourly.precip[i] != null) precips.push(hourly.precip[i]);
      if (hourly.code[i] != null) codes.push(hourly.code[i]);
      if (hourly.precip[i] >= 50) rainHours.push(h);
    }
    if (!temps.length && !codes.length) return null;

    const code = worstCode(codes);
    return {
      tempMin: temps.length ? Math.round(Math.min.apply(null, temps)) : null,
      tempMax: temps.length ? Math.round(Math.max.apply(null, temps)) : null,
      precipMax: precips.length ? Math.round(Math.max.apply(null, precips)) : null,
      code: code,
      icon: describe(code).icon,
      label: describe(code).label,
      rainHours: rainHours
    };
  }

  /** 把连续的小时并成 '14:00–17:00' 这样的区间 */
  function rainWindows(hours) {
    if (!hours || !hours.length) return [];
    const out = [];
    let start = hours[0];
    let prev = hours[0];
    for (let i = 1; i <= hours.length; i++) {
      const h = hours[i];
      if (h !== prev + 1) {
        out.push(pad(start) + ':00–' + pad(prev + 1) + ':00');
        start = h;
      }
      prev = h;
    }
    return out;
  }

  function pad(h) { return String(Math.min(24, h)).padStart(2, '0'); }

  /** 目标日期该走哪条路 */
  function planFor(isoDate, today) {
    const target = new Date((isoDate || '') + 'T12:00:00');
    if (isNaN(target.getTime())) return 'none';
    const now = today ? new Date(today + 'T12:00:00') : new Date();
    const days = Math.round((target - now) / 86400000);
    if (days < -PAST_DAYS) return 'past';
    if (days <= FORECAST_DAYS) return 'forecast';
    return 'normals';
  }

  /* ---------- 缓存 ---------- */
  function cacheAll() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; }
  }

  function cacheGet(key) {
    const all = cacheAll();
    const hit = all[key];
    if (!hit) return null;
    const ttl = hit.data && hit.data.mode === 'forecast' ? FORECAST_TTL : NORMALS_TTL;
    if (Date.now() - hit.ts > ttl) return null;
    return hit.data;
  }

  function cachePut(key, data) {
    const all = cacheAll();
    all[key] = { ts: Date.now(), data: data };
    // 只留最近 120 条，免得越攒越多
    const keys = Object.keys(all);
    if (keys.length > 120) {
      keys.sort(function (a, b) { return all[a].ts - all[b].ts; })
        .slice(0, keys.length - 120)
        .forEach(function (k) { delete all[k]; });
    }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch (e) { /* 满了就算了 */ }
  }

  function keyOf(lat, lng, isoDate) {
    return Number(lat).toFixed(2) + ',' + Number(lng).toFixed(2) + '|' + isoDate;
  }

  /* ---------- 取数 ---------- */
  function fetchDay(lat, lng, isoDate) {
    if (lat == null || lng == null || !isoDate) return Promise.resolve(null);
    const key = keyOf(lat, lng, isoDate);
    const cached = cacheGet(key);
    if (cached) return Promise.resolve(cached);

    const mode = planFor(isoDate);
    const job = mode === 'normals' ? fetchNormals(lat, lng, isoDate) : fetchActual(lat, lng, isoDate, mode);

    return job.then(function (data) {
      if (data) cachePut(key, data);
      return data;
    }).catch(function (err) {
      console.warn('天气查询失败（不影响使用）', err.message);
      return null;
    });
  }

  /** 预报 / 实测：都能拿到逐小时 */
  function fetchActual(lat, lng, isoDate, mode) {
    const base = mode === 'past' ? ARCHIVE : FORECAST;
    const url = base + '?latitude=' + Number(lat).toFixed(4) + '&longitude=' + Number(lng).toFixed(4) +
      '&start_date=' + isoDate + '&end_date=' + isoDate +
      '&hourly=temperature_2m,precipitation_probability,weather_code' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
      '&timezone=auto';

    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (json) { return parseActual(json, mode); });
  }

  function parseActual(json, mode) {
    if (!json || !json.daily || !json.daily.time || !json.daily.time.length) return null;
    const d = json.daily;
    const h = json.hourly || {};
    const hours = (h.time || []).map(function (t) { return parseInt(String(t).slice(11, 13), 10); });

    const code = d.weather_code ? d.weather_code[0] : null;
    return {
      mode: mode,
      date: d.time[0],
      tempMin: round(d.temperature_2m_min && d.temperature_2m_min[0]),
      tempMax: round(d.temperature_2m_max && d.temperature_2m_max[0]),
      precipMax: round(d.precipitation_probability_max && d.precipitation_probability_max[0]),
      code: code,
      icon: describe(code).icon,
      label: describe(code).label,
      hourly: hours.length ? {
        hours: hours,
        temp: h.temperature_2m || [],
        precip: h.precipitation_probability || [],
        code: h.weather_code || []
      } : null
    };
  }

  /** 太远了没有预报：拿往年同一天的实测数据平均一下当参考 */
  function fetchNormals(lat, lng, isoDate) {
    const year = parseInt(isoDate.slice(0, 4), 10);
    const md = isoDate.slice(5);
    const years = [];
    // 从「今年之前」开始往回数，避免取到还没发生的日期
    const latest = Math.min(year, new Date().getFullYear()) - 1;
    for (let i = 0; i < NORMAL_YEARS; i++) years.push(latest - i);

    const jobs = years.map(function (y) {
      const url = ARCHIVE + '?latitude=' + Number(lat).toFixed(4) + '&longitude=' + Number(lng).toFixed(4) +
        '&start_date=' + y + '-' + md + '&end_date=' + y + '-' + md +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto';
      return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    });

    return Promise.all(jobs).then(function (list) {
      const maxes = [];
      const mins = [];
      let wet = 0;
      let counted = 0;

      list.forEach(function (json) {
        const d = json && json.daily;
        if (!d || !d.time || !d.time.length) return;
        if (d.temperature_2m_max[0] == null) return;
        maxes.push(d.temperature_2m_max[0]);
        mins.push(d.temperature_2m_min[0]);
        if ((d.precipitation_sum && d.precipitation_sum[0]) >= 1) wet++;
        counted++;
      });

      if (!counted) return null;
      return {
        mode: 'normals',
        date: isoDate,
        years: years.slice().reverse(),
        sampleSize: counted,
        wetDays: wet,
        tempMin: Math.round(avg(mins)),
        tempMax: Math.round(avg(maxes)),
        hourly: null
      };
    });
  }

  function avg(list) {
    return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
  }

  function round(v) { return v == null ? null : Math.round(v); }

  global.Weather = {
    describe: describe,
    worstCode: worstCode,
    slice: slice,
    rainWindows: rainWindows,
    planFor: planFor,
    parseActual: parseActual,
    fetchDay: fetchDay
  };
})(window);
