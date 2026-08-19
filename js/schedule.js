/*
 * 行程时间推算引擎。
 *
 * 输入：一天的 stops 列表（每个地点带「停留多久」「怎么过去」）+ 每段路程的耗时。
 * 输出：每个地点的 到达 / 开始 / 离开 时间、每段路的 出门时间、以及各种冲突告警。
 *
 * 规则：
 *  - 第 1 个地点（通常是酒店）：开始时间 = 固定时间 ?? 当天出发时间；离开时间 = 开始 + 停留。
 *  - 之后每个地点：到达 = 上一个地点的离开时间 + 路上耗时。
 *  - 如果这个地点有「固定时间」（预约 / 门票时段）：
 *      · 早到 -> 产生 wait（空档）
 *      · 晚到 -> 产生 late 告警，并顺延后面所有安排
 *  - 「几点必须出门」= 该地点的固定时间 - 路上耗时（倒推得到 latestDeparture）。
 */
(function (global) {
  'use strict';

  const U = global.Util;

  /**
   * @param {Object} day  {startTime, stops:[...]}
   * @param {Function} legLookup (fromStop, toStop, mode) => {minutes, km, estimated} | null
   * @returns {Object} {items:[...], summary:{...}}
   */
  function computeDay(day, legLookup) {
    const stops = (day.stops || []).slice();
    const items = [];
    const dayStart = U.toMinutes(day.startTime) != null ? U.toMinutes(day.startTime) : 9 * 60;

    let prevDepart = null;
    let prevStop = null;
    let totalTravel = 0;
    let totalStay = 0;
    let totalKm = 0;
    let totalWait = 0;

    stops.forEach(function (stop, i) {
      const fixed = U.toMinutes(stop.fixedStart);
      const stay = Math.max(0, Number(stop.stayMin) || 0);
      const mode = stop.arriveMode || 'DRIVING';

      let leg = null;
      let arrive;

      if (i === 0) {
        arrive = fixed != null ? fixed : dayStart;
      } else {
        leg = legLookup ? legLookup(prevStop, stop, mode) : null;
        if (!leg) leg = U.estimateLeg(prevStop, stop, mode);
        const travel = leg ? leg.minutes : 0;
        arrive = prevDepart + travel;
        totalTravel += travel;
        if (leg && leg.km != null) totalKm += leg.km;
      }

      // 有固定时间：早到要等，晚到要告警
      let start = arrive;
      let wait = 0;
      let lateBy = 0;
      if (fixed != null && i > 0) {
        if (arrive < fixed) {
          wait = fixed - arrive;
          start = fixed;
          totalWait += wait;
        } else if (arrive > fixed) {
          lateBy = arrive - fixed;
          start = arrive;
        } else {
          start = fixed;
        }
      }

      const depart = start + stay;
      totalStay += stay;

      items.push({
        stop: stop,
        index: i,
        // 这一段路（从上一个地点过来）
        leg: leg ? {
          from: prevStop,
          to: stop,
          mode: mode,
          minutes: leg.minutes,
          km: leg.km,
          estimated: !!leg.estimated,
          // 几点出门（= 上一个地点的离开时间）
          departAt: prevDepart,
          arriveAt: arrive,
          // 若本站有预约，最晚几点必须出门
          latestDeparture: fixed != null ? fixed - leg.minutes : null
        } : null,
        arriveAt: i === 0 ? null : arrive,
        startAt: start,
        departAt: depart,
        stayMin: stay,
        waitMin: wait,
        lateBy: lateBy,
        isFixed: fixed != null
      });

      prevDepart = depart;
      prevStop = stop;
    });

    const first = items[0];
    const last = items[items.length - 1];

    return {
      items: items,
      summary: {
        stopCount: stops.length,
        leaveHomeAt: first ? first.departAt : null,   // 第一次出门时间
        dayStartAt: first ? first.startAt : null,
        dayEndAt: last ? last.departAt : null,
        totalTravel: totalTravel,
        totalStay: totalStay,
        totalWait: totalWait,
        totalKm: Math.round(totalKm * 10) / 10,
        foodCount: stops.filter(function (s) { return s.category === 'food'; }).length,
        lateCount: items.filter(function (it) { return it.lateBy > 0; }).length
      }
    };
  }

  global.Schedule = { computeDay: computeDay };
})(window);
