/*
 * 地图门面：对上层提供一套固定接口，底下可以换不同的地图服务。
 *
 * 现有两套实现：
 *   - MapsGoogle（js/maps-google.js）：Google Maps + Directions + Places，需要 Key 和信用卡
 *   - MapsOSM   （js/maps-osm.js）   ：Leaflet + OpenStreetMap + OpenRouteService + Photon，不用信用卡
 *
 * 接口（两边实现一致）：
 *   loadApi(key)                  载入所需资源，返回 Promise
 *   initMap(container)            在容器里建地图
 *   isReady()                     地图是否可用
 *   renderDay(day, items, opts)   画当天的编号图钉与连线
 *   focusStop(stop)               定位到某个地点
 *   resize()                      容器尺寸变化后重新量
 *   fetchLegs(stops, onProgress)  逐段查真实路程，写进缓存，返回新抓到的段数
 *   attachAutocomplete(input, cb) 给输入框挂地点搜索
 *   escapeHtml(text)
 */
(function (global) {
  'use strict';

  const IMPLS = { google: 'MapsGoogle', osm: 'MapsOSM' };

  let name = 'osm';
  let impl = null;

  /** 根据配置决定用哪套：显式指定 > 有 Google Key 就用 Google > 默认 OSM */
  function pick(cfg) {
    cfg = cfg || {};
    if (IMPLS[cfg.mapProvider]) return cfg.mapProvider;
    if (cfg.mapsApiKey) return 'google';
    return 'osm';
  }

  /** 这套实现要用的 Key（Google 用 Maps Key，OSM 用 OpenRouteService Key） */
  function keyFor(provider, cfg) {
    return provider === 'google' ? (cfg.mapsApiKey || '') : (cfg.orsApiKey || '');
  }

  function use(provider) {
    name = IMPLS[provider] ? provider : 'osm';
    impl = global[IMPLS[name]] || null;
    if (global.Store && global.Store.setProvider) global.Store.setProvider(name);
    return name;
  }

  function current() { return name; }

  /** OSM 不用 Key 也能显示地图，Google 没 Key 什么都做不了 */
  function needsKey() { return name === 'google'; }

  function loadApi(key) {
    if (!impl) return Promise.reject(new Error('没有可用的地图实现'));
    return impl.loadApi(key);
  }

  function initMap(container) { return impl ? impl.initMap(container) : null; }
  function isReady() { return !!impl && impl.isReady(); }
  function renderDay(day, items, options) { if (impl) impl.renderDay(day, items, options); }
  function focusStop(stop) { if (impl) impl.focusStop(stop); }
  function resize() { if (impl && impl.resize) impl.resize(); }
  function fetchLegs(stops, onProgress) {
    return impl ? impl.fetchLegs(stops, onProgress) : Promise.resolve(0);
  }
  function attachAutocomplete(input, onPlace) {
    return impl ? impl.attachAutocomplete(input, onPlace) : null;
  }
  function escapeHtml(s) { return impl ? impl.escapeHtml(s) : String(s == null ? '' : s); }

  /** 有的实现能顺便查到营业时间，没有就当查不到 */
  function fetchHours(placeId) {
    return impl && impl.fetchHours ? impl.fetchHours(placeId) : Promise.resolve('');
  }

  global.Maps = {
    pick: pick,
    keyFor: keyFor,
    use: use,
    current: current,
    needsKey: needsKey,
    loadApi: loadApi,
    initMap: initMap,
    isReady: isReady,
    renderDay: renderDay,
    focusStop: focusStop,
    resize: resize,
    fetchLegs: fetchLegs,
    attachAutocomplete: attachAutocomplete,
    fetchHours: fetchHours,
    escapeHtml: escapeHtml
  };
})(window);
