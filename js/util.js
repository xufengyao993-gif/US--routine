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

  const MODES = {
    DRIVING:   { label: '开车',   icon: '🚗', kmh: 38, overhead: 6 },
    WALKING:   { label: '步行',   icon: '🚶', kmh: 4.5, overhead: 0 },
    TRANSIT:   { label: '公共交通', icon: '🚇', kmh: 20, overhead: 9 },
    BICYCLING: { label: '骑行',   icon: '🚲', kmh: 14, overhead: 2 }
  };

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
    const cfg = MODES[mode] || MODES.DRIVING;
    const routeKm = km * (mode === 'WALKING' ? 1.25 : 1.35);
    const minutes = (routeKm / cfg.kmh) * 60 + cfg.overhead;
    return {
      minutes: Math.max(1, Math.round(minutes)),
      km: Math.round(routeKm * 10) / 10,
      estimated: true
    };
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
    MODES: MODES,
    toMinutes: toMinutes,
    toClock: toClock,
    toDuration: toDuration,
    haversineKm: haversineKm,
    estimateLeg: estimateLeg,
    el: el,
    initials: initials,
    uid: uid,
    formatDate: formatDate
  };
})(window);
