/*
 * 行程数据模型（v2）。
 *
 * 为什么不用数组：多人同时编辑时，数组的下标会互相错位——A 在中间插了一个点，
 * B 同时改了第 5 个点，按下标写回去就会改错人。所以 days / stops 都用「ID 键值表 +
 * order 排序号」存储：
 *   - 每个人只写自己动过的那个 ID 的路径，互不覆盖
 *   - 调顺序只改 order 一个数字（取前后两个 order 的中点，不用重排整个列表）
 * 渲染和排时间之前再用 dayList / stopList 排成数组，schedule.js 完全不用改。
 */
(function (global) {
  'use strict';

  const U = global.Util;
  const ORDER_STEP = 1024;

  function sortByOrder(map) {
    return Object.keys(map || {})
      .map(function (k) {
        const v = map[k];
        return Object.assign({}, v, { id: v.id || k });
      })
      .sort(function (a, b) {
        const d = (a.order || 0) - (b.order || 0);
        return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
      });
  }

  function dayList(trip) { return sortByOrder(trip && trip.days); }
  function stopList(day) { return sortByOrder(day && day.stops); }

  /** 追加到末尾时用的 order */
  function nextOrder(map) {
    const items = sortByOrder(map);
    if (!items.length) return ORDER_STEP;
    return (items[items.length - 1].order || 0) + ORDER_STEP;
  }

  /**
   * 把 item 移到 targetIndex 位置需要的新 order（取邻居中点）。
   * @param {Array} sorted 已排序的列表（不含移动后的状态）
   * @param {number} from 当前下标
   * @param {number} to   目标下标
   */
  function orderForMove(sorted, from, to) {
    const without = sorted.slice();
    without.splice(from, 1);
    const before = without[to - 1];
    const after = without[to];
    if (!before && !after) return ORDER_STEP;
    if (!before) return (after.order || ORDER_STEP) - ORDER_STEP;
    if (!after) return (before.order || 0) + ORDER_STEP;
    const mid = ((before.order || 0) + (after.order || 0)) / 2;
    // 中点和邻居撞上了（order 被切得太细）说明该重排一次
    if (mid <= (before.order || 0) || mid >= (after.order || 0)) return null;
    return mid;
  }

  /** order 精度用尽时，把整个列表重新按 1024 步长排一遍 */
  function reindex(map) {
    const items = sortByOrder(map);
    const patch = {};
    items.forEach(function (it, i) {
      patch[it.id] = (i + 1) * ORDER_STEP;
    });
    return patch;
  }

  /* ---------- 按固定时间排序 ---------- */
  /**
   * 按「固定时间」把一天的地点重排。
   *
   * 只有填了固定时间的地点才有绝对时刻，没填的那些没有自己的时间——
   * 它们的时间是被前面的地点推出来的。所以规则是：
   *   每个「有固定时间」的地点，带着它后面那串「没固定时间」的一起搬家，
   *   第一个固定时间之前的那些（通常是酒店、早餐）永远留在最前面。
   * 这样重排之后，你原本安排在某顿饭之后的几个点，还是跟着那顿饭走。
   */
  function sortByFixedTime(stops) {
    const lead = [];
    const groups = [];

    (stops || []).forEach(function (stop) {
      const at = U.toMinutes(stop.fixedStart);
      if (at != null) groups.push({ at: at, anchor: stop, tail: [] });
      else if (groups.length) groups[groups.length - 1].tail.push(stop);
      else lead.push(stop);
    });

    groups.sort(function (a, b) { return a.at - b.at; });

    const out = lead.slice();
    groups.forEach(function (g) {
      out.push(g.anchor);
      g.tail.forEach(function (s) { out.push(s); });
    });
    return out;
  }

  /** 当前顺序里有几处固定时间是倒着的（后面的比前面的早） */
  function fixedOutOfOrder(stops) {
    const times = (stops || [])
      .map(function (s) { return U.toMinutes(s.fixedStart); })
      .filter(function (t) { return t != null; });
    let n = 0;
    for (let i = 1; i < times.length; i++) {
      if (times[i] < times[i - 1]) n++;
    }
    return n;
  }

  /* ---------- 顺序建议（只提示，不自动改） ---------- */
  /**
   * 看看换个顺序能不能少绕路。
   *
   * 几条自我约束，因为「你这样排也许自有道理」：
   *   - 第一个和最后一个不动（通常是酒店）
   *   - 填了固定时间的地点原地不动（订位、门票时段）
   *   - 只在「相邻且都没被钉住」的一段里做 2-opt 反转
   *   - 省得不够多就不吭声
   *
   * 用的是直线估算而不是真实路线：不额外消耗路线额度，也能离线算。
   * 所以给出的数字是「大概」，界面上要说清楚。
   *
   * @returns {Object|null} {order:[id…], savedMinutes, savedKm, from:[name…], to:[name…]}
   */
  function suggestOrder(stops, opts) {
    const list = (stops || []).slice();
    const withCoords = list.filter(function (s) { return s.lat != null && s.lng != null; });
    if (list.length < 4 || withCoords.length < 4) return null;

    const options = opts || {};
    const minSaved = options.minSaved || 10;         // 至少省这么多分钟才说
    const minRatio = options.minRatio || 0.08;       // 且至少省这么大比例

    // 钉住不动的：首尾、有固定时间的、以及没坐标的
    // （没坐标就无从判断远近，与其瞎猜，不如让它留在原地，别的点照样能优化）
    const pinnedIds = {};
    list.forEach(function (s, i) {
      if (i === 0 || i === list.length - 1 || U.toMinutes(s.fixedStart) || s.lat == null) {
        pinnedIds[s.id] = true;
      }
    });

    const cost = function (seq) {
      let total = 0;
      for (let i = 1; i < seq.length; i++) {
        const leg = U.estimateLeg(seq[i - 1], seq[i], seq[i].arriveMode);
        if (leg) total += leg.minutes;
      }
      return total;
    };

    const km = function (seq) {
      let total = 0;
      for (let i = 1; i < seq.length; i++) {
        const leg = U.estimateLeg(seq[i - 1], seq[i], seq[i].arriveMode);
        if (leg && leg.km != null) total += leg.km;
      }
      return total;
    };

    const before = cost(list);
    let best = list.slice();
    let bestCost = before;

    // 2-opt：反转一段中间的顺序，看看总路程是不是更短
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 40) {
      improved = false;
      for (let i = 1; i < best.length - 2; i++) {
        for (let j = i + 1; j < best.length - 1; j++) {
          let blocked = false;
          for (let k = i; k <= j; k++) {
            if (pinnedIds[best[k].id]) { blocked = true; break; }
          }
          if (blocked) continue;

          const candidate = best.slice(0, i)
            .concat(best.slice(i, j + 1).reverse())
            .concat(best.slice(j + 1));
          const c = cost(candidate);
          if (c < bestCost - 0.5) {
            best = candidate;
            bestCost = c;
            improved = true;
          }
        }
      }
    }

    const saved = before - bestCost;
    if (saved < minSaved || saved / Math.max(1, before) < minRatio) return null;

    return {
      order: best.map(function (s) { return s.id; }),
      savedMinutes: Math.round(saved),
      savedKm: Math.round((km(list) - km(best)) * 10) / 10,
      from: list.map(function (s) { return s.name; }),
      to: best.map(function (s) { return s.name; })
    };
  }

  /* ---------- 按路径读写（撤销功能要靠它拿「改之前的值」） ---------- */
  /** 读 'days/d1/stops/s3/stayMin' 这样的路径，返回深拷贝（避免后续改动串了引用） */
  function getAtPath(root, path) {
    const parts = String(path).split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      if (node == null || typeof node !== 'object') return null;
      node = node[parts[i]];
    }
    if (node === undefined) return null;
    return node && typeof node === 'object' ? JSON.parse(JSON.stringify(node)) : node;
  }

  /** 写同样的路径；值为 null 表示删除这个节点 */
  function setAtPath(root, path, value) {
    const parts = String(path).split('/').filter(Boolean);
    if (!parts.length) return;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (node[k] == null || typeof node[k] !== 'object') node[k] = {};
      node = node[k];
    }
    const last = parts[parts.length - 1];
    if (value === null || value === undefined) delete node[last];
    else node[last] = value;
  }

  /** 给一批改动生成「反操作」：把每条路径改之前的值记下来 */
  function inverseOf(root, patch) {
    const inverse = {};
    Object.keys(patch).forEach(function (path) {
      inverse[path] = getAtPath(root, path);
    });
    return inverse;
  }

  /* ---------- v1（数组）-> v2（键值表）迁移 ---------- */
  function migrate(trip) {
    if (!trip) return null;
    if (trip.version >= 2 && trip.days && !Array.isArray(trip.days)) return trip;

    const days = {};
    (Array.isArray(trip.days) ? trip.days : []).forEach(function (day, i) {
      const dayId = day.id || U.uid('day');
      const stops = {};
      (day.stops || []).forEach(function (stop, j) {
        const stopId = stop.id || U.uid('stop');
        stops[stopId] = Object.assign({}, stop, { id: stopId, order: (j + 1) * ORDER_STEP });
      });
      days[dayId] = {
        id: dayId,
        order: (i + 1) * ORDER_STEP,
        date: day.date || '',
        title: day.title || '第 ' + (i + 1) + ' 天',
        startTime: day.startTime || '09:00',
        stops: stops
      };
    });

    return {
      version: 2,
      id: trip.id || null,
      title: trip.title || '我的行程',
      days: days,
      updatedAt: Date.now()
    };
  }

  /** 导出成人类可读的数组结构（导出 JSON 时用，也兼容旧版本） */
  function toPlain(trip) {
    return {
      version: 2,
      title: trip.title,
      days: dayList(trip).map(function (day) {
        return {
          id: day.id, date: day.date, title: day.title, startTime: day.startTime,
          stops: stopList(day).map(function (s) {
            return {
              id: s.id, name: s.name, category: s.category, address: s.address,
              lat: s.lat, lng: s.lng, stayMin: s.stayMin, arriveMode: s.arriveMode,
              fixedStart: s.fixedStart || '', notes: s.notes || ''
            };
          })
        };
      })
    };
  }

  /** 随机行程 ID：够长，链接不会被猜到 */
  function newTripId() {
    const bytes = new Uint8Array(12);
    (global.crypto || global.msCrypto).getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  global.Model = {
    ORDER_STEP: ORDER_STEP,
    dayList: dayList,
    stopList: stopList,
    sortByOrder: sortByOrder,
    nextOrder: nextOrder,
    orderForMove: orderForMove,
    reindex: reindex,
    sortByFixedTime: sortByFixedTime,
    suggestOrder: suggestOrder,
    fixedOutOfOrder: fixedOutOfOrder,
    getAtPath: getAtPath,
    setAtPath: setAtPath,
    inverseOf: inverseOf,
    migrate: migrate,
    toPlain: toPlain,
    newTripId: newTripId
  };
})(window);
