/* 通用工具：时间换算、距离估算、DOM 帮助函数 */
(function (global) {
  'use strict';

  const CATEGORIES = {
    attraction: { label: '景点', icon: '🏛️', color: '#3b82f6' },
    food:       { label: '吃饭', icon: '🍜', color: '#f97316' },
    hotel:      { label: '住宿', icon: '🏨', color: '#8b5cf6' },
    transport:  { label: '交通', icon: '✈️', color: '#0ea5e9' },
    shopping:   { label: '购物', icon: '🛍️', color: '#ec4899' },
    outdoor:    { label: '户外', icon: '🏞️', color: '#22c55e' },
    other:      { label: '其他', icon: '📍', color: '#64748b' }
  };

  /**
   * 交通方式。routing 是算路线时真正用的档位——Uber、租车、旅行团
   * 走的是同一条路、同样的耗时，区别只在你怎么坐上这辆车。
   */
  const MODES = {
    UBER:      { label: 'Uber',    icon: '🚕', kmh: 38, overhead: 6, routing: 'DRIVING' },
    RENTAL:    { label: '租车',    icon: '🚗', kmh: 38, overhead: 6, routing: 'DRIVING' },
    TOUR:      { label: '旅行团',  icon: '🚌', kmh: 38, overhead: 6, routing: 'DRIVING' },
    TRANSIT:   { label: '公共交通', icon: '🚇', kmh: 20, overhead: 9, routing: 'TRANSIT' },
    WALKING:   { label: '步行',    icon: '🚶', kmh: 4.5, overhead: 0, routing: 'WALKING' },
    BICYCLING: { label: '骑行',    icon: '🚲', kmh: 14, overhead: 2, routing: 'BICYCLING' }
  };

  // 老数据（以及还没刷新到新版的同伴）里存的是 DRIVING，一律当成「租车」
  const MODE_ALIASES = { DRIVING: 'RENTAL', CAR: 'RENTAL', TAXI: 'UBER' };
  const DEFAULT_MODE = 'RENTAL';

  /** 任何来源的交通方式值 -> 现在认识的那一个 */
  function normalizeMode(mode) {
    const m = String(mode || '').toUpperCase();
    if (MODES[m]) return m;
    if (MODE_ALIASES[m]) return MODE_ALIASES[m];
    return DEFAULT_MODE;
  }

  function modeInfo(mode) { return MODES[normalizeMode(mode)]; }

  /** 算路线时用哪个档位（三种车共用 DRIVING） */
  function routingOf(mode) { return modeInfo(mode).routing; }

  /** 'HH:MM' -> 从 0 点起的分钟数 */
  function toMinutes(hhmm) {
    if (typeof hhmm !== 'string') return null;
    const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  /** 分钟数 -> 'HH:MM'，超过 24 点显示为「次日 HH:MM」 */
  function toClock(mins) {
    if (mins == null || isNaN(mins)) return '--:--';
    const wrapped = ((Math.round(mins) % 1440) + 1440) % 1440;
    const h = String(Math.floor(wrapped / 60)).padStart(2, '0');
    const m = String(wrapped % 60).padStart(2, '0');
    const prefix = mins >= 1440 ? '次日 ' : '';
    return prefix + h + ':' + m;
  }

  /** 时长（分钟）-> 「1小时20分」 */
  function toDuration(mins) {
    if (mins == null || isNaN(mins)) return '--';
    const total = Math.max(0, Math.round(mins));
    if (total === 0) return '0 分钟';
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return m + ' 分钟';
    if (m === 0) return h + ' 小时';
    return h + ' 小时 ' + m + ' 分';
  }

  /* ================= 时区 =================
   * 一天的时间轴始终按「这一天的基准时区」推算（通常是出发地）。
   * 某个地点在别的时区时，只是额外标一行当地时刻，不改变时间轴本身——
   * 否则跨时区那天的先后顺序会变得没法读。
   */

  /** 某时区在某一瞬间的偏移（分钟，东为正）；时区名不认识返回 null */
  function tzOffsetAt(tz, instant) {
    if (!tz) return null;
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const p = {};
      dtf.formatToParts(instant).forEach(function (x) { p[x.type] = x.value; });
      // 把该时区读出来的「墙上时间」当成 UTC，与真正的 UTC 之差就是偏移
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
      return Math.round((asUTC - instant.getTime()) / 60000);
    } catch (e) {
      return null;
    }
  }

  function isValidTz(tz) {
    if (!tz) return false;
    return tzOffsetAt(tz, new Date()) != null;
  }

  /**
   * 「某时区里 dateISO 这天的第 minutes 分钟」-> 绝对时刻。
   * 偏移本身取决于时刻（夏令时），所以迭代两次让它收敛。
   * minutes 允许超过 1440，表示跨到次日。
   */
  function wallToInstant(dateISO, minutes, tz) {
    const parts = String(dateISO || '').split('-');
    if (parts.length !== 3) return null;
    const base = Date.UTC(+parts[0], +parts[1] - 1, +parts[2], 0, Math.round(minutes || 0));
    if (isNaN(base)) return null;
    if (!tz) return new Date(base);
    let guess = new Date(base);
    for (let i = 0; i < 2; i++) {
      const off = tzOffsetAt(tz, guess);
      if (off == null) return new Date(base);
      guess = new Date(base - off * 60000);
    }
    return guess;
  }

  /** 绝对时刻 -> 某时区的墙上时间 {date:'YYYY-MM-DD', minutes} */
  function instantToWall(instant, tz) {
    const opts = { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    if (tz) opts.timeZone = tz;
    let p = {};
    try {
      new Intl.DateTimeFormat('en-US', opts).formatToParts(instant).forEach(function (x) { p[x.type] = x.value; });
    } catch (e) {
      return null;
    }
    return { date: p.year + '-' + p.month + '-' + p.day, minutes: ((+p.hour) % 24) * 60 + (+p.minute) };
  }

  /** 两个 'YYYY-MM-DD' 相差几天（b - a） */
  function daysBetween(a, b) {
    const pa = String(a || '').split('-');
    const pb = String(b || '').split('-');
    if (pa.length !== 3 || pb.length !== 3) return 0;
    const ta = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]);
    const tb = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
    return Math.round((tb - ta) / 86400000);
  }

  /**
   * 基准时区里的时刻 -> 目标时区的当地时刻。
   * 返回 {minutes, dayDelta}，dayDelta 是相对基准那天的日期差（+1 = 当地已是次日）。
   * 两个时区相同、缺参数、时区名不认识时返回 null（界面据此不显示当地时间）。
   */
  function localAt(dateISO, minutes, baseTz, targetTz) {
    if (!baseTz || !targetTz || baseTz === targetTz || minutes == null) return null;
    const inst = wallToInstant(dateISO, minutes, baseTz);
    if (!inst || isNaN(inst.getTime())) return null;
    const wall = instantToWall(inst, targetTz);
    if (!wall) return null;
    return { minutes: wall.minutes, dayDelta: daysBetween(dateISO, wall.date) };
  }

  /** 当地时刻的展示写法：'14:40'、'次日 05:20'、'前一天 23:10' */
  function localClock(local) {
    if (!local) return '';
    const hhmm = toClock(((local.minutes % 1440) + 1440) % 1440);
    if (local.dayDelta > 1) return '+' + local.dayDelta + ' 天 ' + hhmm;
    if (local.dayDelta === 1) return '次日 ' + hhmm;
    if (local.dayDelta === -1) return '前一天 ' + hhmm;
    if (local.dayDelta < -1) return local.dayDelta + ' 天 ' + hhmm;
    return hhmm;
  }

  /** 时区名的简短写法：Asia/Manila -> Manila */
  function tzShort(tz) {
    if (!tz) return '';
    const parts = String(tz).split('/');
    return parts[parts.length - 1].replace(/_/g, ' ');
  }

  /**
   * 这个地点算不算「在外面玩」。
   * 住宿默认算休息（睡觉不是游玩），其余默认算游玩；
   * 每个地点都能单独覆盖（比如机场候机三小时，也不该算游玩）。
   */
  function isRest(stop) {
    if (!stop) return false;
    if (stop.rest === true) return true;
    if (stop.rest === false) return false;
    return stop.category === 'hotel';
  }

  /** 两点球面距离，单位 km */
  function haversineKm(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const la1 = a.lat * Math.PI / 180;
    const la2 = b.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * 没有 Directions API 结果时的兜底估算：
   * 直线距离 × 绕路系数 ÷ 平均速度 + 固定开销（找车位 / 等车）
   */
  function estimateLeg(from, to, mode) {
    const km = haversineKm(from, to);
    if (km == null) return null;
    const cfg = modeInfo(mode);
    const routeKm = km * (cfg.routing === 'WALKING' ? 1.25 : 1.35);
    const minutes = (routeKm / cfg.kmh) * 60 + cfg.overhead;
    return {
      minutes: Math.max(1, Math.round(minutes)),
      km: Math.round(routeKm * 10) / 10,
      estimated: true
    };
  }

  /**
   * 生成 Google 地图导航链接。
   * 手机上装了 Google 地图 App 时，这个链接会被 App 接管（iOS 通用链接 / Android intent），
   * dir_action=navigate 让它直接进入导航，而不是只展示路线。
   */
  function navUrl(from, to, mode) {
    const point = function (p) {
      if (!p) return '';
      if (p.lat != null && p.lng != null) return Number(p.lat) + ',' + Number(p.lng);
      return p.name || '';
    };
    const params = [
      'api=1',
      'origin=' + encodeURIComponent(point(from)),
      'destination=' + encodeURIComponent(point(to)),
      'travelmode=' + routingOf(mode).toLowerCase(),
      'dir_action=navigate'
    ];
    return 'https://www.google.com/maps/dir/?' + params.join('&');
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  /**
   * Date -> 'yyyy-mm-dd'，按**本地时区**。
   * 不能用 toISOString()：它先转成 UTC，东八区会整整倒退一天
   * （本地 9/13 00:00 在 UTC 还是 9/12 16:00，切出来就成了 9/12）。
   */
  function toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /** 'yyyy-mm-dd' 加 n 天，返回同样格式；传空值时以今天为准 */
  function addDays(iso, n) {
    const base = iso ? new Date(iso + 'T12:00:00') : new Date();   // 中午为锚，躲开夏令时切换
    if (isNaN(base.getTime())) return toISODate(new Date());
    base.setDate(base.getDate() + (n || 0));
    return toISODate(base);
  }

  /** 时间戳 -> 「刚刚 / 3 分钟前 / 2 小时前 / 昨天 14:30」 */
  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    const d = new Date(ts);
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (diff < 48 * 60 * 60 * 1000) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  /** 头像上的字：中文名取末字（小明/小红 -> 明/红），英文名取首字母 */
  function initials(name) {
    const n = String(name || '?').replace(/（.*?）|\(.*?\)/g, '').trim();
    if (!n) return '?';
    if (/[\u4e00-\u9fa5]/.test(n)) return n[n.length - 1];
    return n[0].toUpperCase();
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 9);
  }

  /** 'yyyy-mm-dd' -> '9月12日 周五' */
  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + week;
  }

  global.Util = {
    CATEGORIES: CATEGORIES,
    tzOffsetAt: tzOffsetAt,
    isValidTz: isValidTz,
    wallToInstant: wallToInstant,
    instantToWall: instantToWall,
    daysBetween: daysBetween,
    localAt: localAt,
    localClock: localClock,
    tzShort: tzShort,
    isRest: isRest,
    MODES: MODES,
    DEFAULT_MODE: DEFAULT_MODE,
    normalizeMode: normalizeMode,
    modeInfo: modeInfo,
    routingOf: routingOf,
    toMinutes: toMinutes,
    toClock: toClock,
    toDuration: toDuration,
    haversineKm: haversineKm,
    estimateLeg: estimateLeg,
    el: el,
    navUrl: navUrl,
    initials: initials,
    relTime: relTime,
    uid: uid,
    formatDate: formatDate,
    toISODate: toISODate,
    addDays: addDays
  };
})(window);
