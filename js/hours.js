/*
 * 营业时间：解析 OpenStreetMap 的 opening_hours 写法，并检查「你到的时候人家开不开门」。
 *
 * 完整的 opening_hours 规范很庞大（节假日、日出日落、第几周…），
 * 这里只认最常见的那部分。**认不出来的一律当作「不知道」，绝不报假警**——
 * 宁可不提醒，也不要因为解析不了就误导你改行程。
 *
 * 认得的写法：
 *   24/7
 *   Mo-Fr 09:00-17:00
 *   Mo,We,Fr 10:00-18:00
 *   Mo-Fr 09:00-12:00,13:00-18:00
 *   Mo-Sa 10:00-22:00; Su 11:00-20:00
 *   Mo-Fr 09:00-17:00; We off
 *   09:00-17:00              （没写星期 = 每天）
 *   18:00-02:00              （跨夜）
 */
(function (global) {
  'use strict';

  const DAY_INDEX = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
  const DAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 24 || min > 59) return null;
    return h * 60 + min;
  }

  /** 'Mo-Fr' / 'Mo,We' / 'Mo-Fr,Su' -> [1,2,3,4,5] */
  function parseDays(spec) {
    const out = [];
    const parts = spec.split(',');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim().toLowerCase();
      if (!part) continue;
      const range = /^([a-z]{2})\s*-\s*([a-z]{2})$/.exec(part);
      if (range) {
        const from = DAY_INDEX[range[1]];
        const to = DAY_INDEX[range[2]];
        if (from == null || to == null) return null;
        // 允许 Sa-Su 这种跨周末的写法
        for (let d = from; ; d = (d + 1) % 7) {
          out.push(d);
          if (d === to) break;
          if (out.length > 7) return null;
        }
        continue;
      }
      if (DAY_INDEX[part] == null) return null;
      out.push(DAY_INDEX[part]);
    }
    return out.length ? out : null;
  }

  /** '09:00-12:00,13:00-18:00' -> [[540,720],[780,1080]]，跨夜的结束时间会 +24h */
  function parseRanges(spec) {
    const out = [];
    const parts = spec.split(',');
    for (let i = 0; i < parts.length; i++) {
      const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(parts[i].trim());
      if (!m) return null;
      const start = toMinutes(m[1]);
      let end = toMinutes(m[2]);
      if (start == null || end == null) return null;
      if (end <= start) end += 1440;              // 18:00-02:00 这种
      out.push([start, end]);
    }
    return out.length ? out : null;
  }

  /**
   * @returns {Object} {known:boolean, always:boolean, byDay:{0..6: ranges|null}}
   *   byDay[d] === null 表示那天不营业；undefined 表示这条没说到那天
   */
  function parse(text) {
    const raw = String(text || '').trim();
    if (!raw) return { known: false, always: false, byDay: {} };
    if (/^24\s*\/\s*7$/.test(raw)) return { known: true, always: true, byDay: {} };

    const byDay = {};
    const rules = raw.split(';');

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i].trim();
      if (!rule) continue;

      // 认不出来的一律放弃整条，避免半懂不懂地误判
      const m = /^([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)?\s*(off|closed|\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}(?:\s*,\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})*)$/
        .exec(rule);
      if (!m) return { known: false, always: false, byDay: {} };

      const days = m[1] ? parseDays(m[1]) : [0, 1, 2, 3, 4, 5, 6];
      if (!days) return { known: false, always: false, byDay: {} };

      const timePart = m[2].toLowerCase();
      const ranges = (timePart === 'off' || timePart === 'closed') ? null : parseRanges(m[2]);
      if (ranges === null && timePart !== 'off' && timePart !== 'closed') {
        return { known: false, always: false, byDay: {} };
      }

      // 后面的规则覆盖前面的（opening_hours 的语义）
      days.forEach(function (d) { byDay[d] = ranges; });
    }

    return { known: Object.keys(byDay).length > 0, always: false, byDay: byDay };
  }

  /**
   * 检查一次到访是否落在营业时间内。
   * @param {string} text     opening_hours 原文
   * @param {number} weekday  0=周日 … 6=周六
   * @param {number} startAt  到访开始（当天 0 点起的分钟）
   * @param {number} endAt    到访结束
   * @returns {Object} {status, message, openAt, closeAt}
   *   status: 'unknown' | 'open' | 'closed-day' | 'before-open' | 'after-close' | 'cut-short'
   */
  function check(text, weekday, startAt, endAt) {
    const parsed = parse(text);
    if (!parsed.known) return { status: 'unknown' };
    if (parsed.always) return { status: 'open' };

    const ranges = parsed.byDay[weekday];
    if (ranges === undefined || ranges === null) {
      return { status: 'closed-day', message: DAY_LABEL[weekday] + '不营业' };
    }

    // 找一个能容下这次到访的时段；容不下就挑最接近的那个来解释原因
    let best = null;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (startAt >= r[0] && endAt <= r[1]) return { status: 'open', openAt: r[0], closeAt: r[1] };
      if (!best || Math.abs(r[0] - startAt) < Math.abs(best[0] - startAt)) best = r;
    }

    const open = best[0];
    const close = best[1];
    if (endAt <= open) {
      return { status: 'before-open', openAt: open, closeAt: close, message: fmt(open) + ' 才开门' };
    }
    if (startAt >= close) {
      return { status: 'after-close', openAt: open, closeAt: close, message: fmt(close) + ' 就关门了' };
    }
    if (startAt < open) {
      return { status: 'before-open', openAt: open, closeAt: close, message: fmt(open) + ' 才开门，你 ' + fmt(startAt) + ' 就到了' };
    }
    return { status: 'cut-short', openAt: open, closeAt: close, message: fmt(close) + ' 关门，你排到 ' + fmt(endAt) };
  }

  function fmt(mins) {
    const wrapped = ((Math.round(mins) % 1440) + 1440) % 1440;
    return String(Math.floor(wrapped / 60)).padStart(2, '0') + ':' + String(wrapped % 60).padStart(2, '0');
  }

  /** 'yyyy-mm-dd' -> 0..6，按本地时区 */
  function weekdayOf(iso) {
    if (!iso) return null;
    const d = new Date(iso + 'T12:00:00');
    return isNaN(d.getTime()) ? null : d.getDay();
  }

  global.Hours = {
    parse: parse,
    check: check,
    weekdayOf: weekdayOf,
    DAY_LABEL: DAY_LABEL
  };
})(window);
