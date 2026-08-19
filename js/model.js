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
    getAtPath: getAtPath,
    setAtPath: setAtPath,
    inverseOf: inverseOf,
    migrate: migrate,
    toPlain: toPlain,
    newTripId: newTripId
  };
})(window);
