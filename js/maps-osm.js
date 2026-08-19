/*
 * OpenStreetMap 实现（接口见 js/maps.js 的说明）。
 *
 * 为什么有这一套：Google Cloud 在中国大陆不提供付费服务，拿不到 Maps Key。
 * 这条路线全部不需要信用卡：
 *   - 地图显示：Leaflet + OpenStreetMap 瓦片，连注册都不用
 *   - 路线与耗时：OpenRouteService，邮箱注册就给 Key，每天 2000 次免费
 *   - 地点搜索：Photon（OSM 数据），不用注册
 *
 * 已知短板（在界面上如实标出来）：
 *   - 没有实时路况，开车耗时偏乐观
 *   - 不支持公共交通，那一档继续走直线估算
 */
(function (global) {
  'use strict';

  const U = global.Util;
  const LEAFLET_JS = 'vendor/leaflet/leaflet.js';
  const LEAFLET_CSS = 'vendor/leaflet/leaflet.css';
  // OpenRouteService 正在把域名从 api.openrouteservice.org 迁到 api.heigit.org。
  // 旧域名现在还能用，但迟早会关。按顺序试，哪个通了就记住哪个，
  // 免得旧域名下线那天（很可能是你正在路上的时候）路程时间悄悄变回估算。
  const ORS_HOSTS = [
    'https://api.openrouteservice.org/v2/directions/',
    'https://api.heigit.org/ors/v2/directions/',
    'https://api.heigit.org/v2/directions/'
  ];
  const ORS_HOST_KEY = 'us-routine.ors-host';
  const PHOTON = 'https://photon.komoot.io/api';

  // routing 档位 -> ORS 的 profile。公交没有对应项，只能估算。
  // Uber / 租车 / 旅行团都归到 DRIVING，同一条路只查一次。
  const PROFILES = {
    DRIVING: 'driving-car',
    WALKING: 'foot-walking',
    BICYCLING: 'cycling-regular',
    TRANSIT: null
  };

  let map = null;
  let ready = false;
  let loadPromise = null;
  let orsKey = '';
  let markers = [];
  let lines = [];

  function isReady() { return ready && !!map; }

  /** @param {string} key OpenRouteService 的 Key，留空则地图能用、路程走估算 */
  function loadApi(key) {
    orsKey = (key || '').trim();
    if (loadPromise) return loadPromise;

    loadPromise = new Promise(function (resolve, reject) {
      if (global.L) { ready = true; resolve(); return; }

      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CSS;
      document.head.appendChild(css);

      const script = document.createElement('script');
      script.src = LEAFLET_JS;
      script.async = true;
      script.onload = function () { ready = true; resolve(); };
      script.onerror = function () {
        loadPromise = null;
        reject(new Error('地图库加载失败（vendor/leaflet/leaflet.js 没找到）'));
      };
      document.head.appendChild(script);
    });
    return loadPromise;
  }

  function initMap(container) {
    if (!ready) return null;
    map = global.L.map(container, {
      center: [37.7879, -122.4103],
      zoom: 12,
      zoomControl: true,
      attributionControl: true
    });

    global.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '地图数据 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 贡献者' +
        ' · 路线 <a href="https://openrouteservice.org/" target="_blank" rel="noopener">openrouteservice</a>'
    }).addTo(map);

    return map;
  }

  function clearOverlays() {
    markers.forEach(function (m) { map.removeLayer(m); });
    lines.forEach(function (l) { map.removeLayer(l); });
    markers = [];
    lines = [];
  }

  /** 带编号的图钉：一个圆头加一个尖角，颜色按地点类型 */
  function pinIcon(color, label, active) {
    const size = active ? 38 : 32;
    return global.L.divIcon({
      className: 'osm-pin' + (active ? ' is-active' : ''),
      html: '<span class="osm-pin-body" style="background:' + color + '"><b>' + label + '</b></span>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size]
    });
  }

  function renderDay(day, items, options) {
    if (!isReady()) return;
    options = options || {};
    clearOverlays();

    const bounds = [];

    items.forEach(function (item, i) {
      const stop = item.stop;
      if (stop.lat == null || stop.lng == null) return;
      const cat = U.CATEGORIES[stop.category] || U.CATEGORIES.other;
      const pos = [Number(stop.lat), Number(stop.lng)];
      bounds.push(pos);

      const marker = global.L.marker(pos, {
        icon: pinIcon(cat.color, String(i + 1), options.activeStopId === stop.id),
        zIndexOffset: options.activeStopId === stop.id ? 1000 : i,
        title: stop.name
      }).addTo(map);

      marker.bindPopup(
        '<div style="font:13px/1.6 system-ui;max-width:230px">' +
        '<div style="font-weight:700;margin-bottom:2px">' + cat.icon + ' ' + escapeHtml(stop.name) + '</div>' +
        '<div style="color:#475569">' + U.toClock(item.startAt) + ' – ' + U.toClock(item.departAt) +
        '（停留 ' + U.toDuration(item.stayMin) + '）</div>' +
        (stop.address ? '<div style="color:#94a3b8;margin-top:2px">' + escapeHtml(stop.address) + '</div>' : '') +
        '</div>'
      );

      marker.on('click', function () {
        if (options.onMarkerClick) options.onMarkerClick(stop.id);
      });

      markers.push(marker);
    });

    // 连线：有真实路线画真实路线，没有画虚线直连
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1].stop;
      const b = items[i].stop;
      if (a.lat == null || b.lat == null) continue;

      const mode = U.normalizeMode(items[i].stop.arriveMode);
      const cached = global.Store.getLeg(a, b, mode);
      const real = cached && cached.path && cached.path.length > 1;
      const path = real ? cached.path : [[Number(a.lat), Number(a.lng)], [Number(b.lat), Number(b.lng)]];

      lines.push(global.L.polyline(path, real
        ? { color: '#2563eb', weight: 5, opacity: 0.85 }
        : { color: '#94a3b8', weight: 3, opacity: 0.7, dashArray: '6 8' }
      ).addTo(map));
    }

    if (bounds.length && !options.keepViewport) {
      if (bounds.length === 1) map.setView(bounds[0], 14);
      else map.fitBounds(bounds, { padding: [50, 50] });
    }
  }

  function focusStop(stop) {
    if (!isReady() || stop.lat == null) return;
    map.panTo([Number(stop.lat), Number(stop.lng)]);
    if (map.getZoom() < 14) map.setZoom(15);
  }

  function resize() {
    if (isReady()) map.invalidateSize();
  }

  /** 逐段向 OpenRouteService 要真实路线，结果写进缓存 */
  function fetchLegs(stops, onProgress) {
    if (!isReady() || !orsKey) return Promise.resolve(0);
    stops = stops || [];

    const jobs = [];
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1];
      const b = stops[i];
      const mode = U.normalizeMode(b.arriveMode);
      if (a.lat == null || b.lat == null) continue;
      if (!PROFILES[U.routingOf(mode)]) continue;          // 公交：只能估算
      if (global.Store.getLeg(a, b, mode)) continue;
      jobs.push({ a: a, b: b, mode: mode });
    }
    if (!jobs.length) return Promise.resolve(0);

    let done = 0;
    return jobs.reduce(function (chain, job) {
      return chain.then(function () {
        return requestLeg(job.a, job.b, job.mode).then(function (result) {
          if (result) global.Store.putLeg(job.a, job.b, job.mode, result);
          done++;
          if (onProgress) onProgress(done, jobs.length);
          return new Promise(function (r) { setTimeout(r, 350); });   // ORS 免费档限速
        });
      });
    }, Promise.resolve()).then(function () { return done; });
  }

  /** 上次用通的那个域名排到最前面 */
  function hostOrder() {
    let saved = null;
    try { saved = localStorage.getItem(ORS_HOST_KEY); } catch (e) { /* 无痕模式 */ }
    if (!saved || ORS_HOSTS.indexOf(saved) < 0) return ORS_HOSTS.slice();
    return [saved].concat(ORS_HOSTS.filter(function (h) { return h !== saved; }));
  }

  function rememberHost(host) {
    try { localStorage.setItem(ORS_HOST_KEY, host); } catch (e) { /* 无所谓 */ }
  }

  function requestLeg(a, b, mode) {
    const profile = PROFILES[U.routingOf(mode)];
    if (!profile) return Promise.resolve(null);

    const query = profile + '?api_key=' + encodeURIComponent(orsKey) +
      '&start=' + Number(a.lng) + ',' + Number(a.lat) +
      '&end=' + Number(b.lng) + ',' + Number(b.lat);

    const hosts = hostOrder();

    function attempt(i) {
      if (i >= hosts.length) return Promise.resolve(null);
      return fetch(hosts[i] + query)
        .then(function (res) {
          // 401/403 是 Key 的问题，换域名也没用；只有找不到路由才值得换
          if (res.status === 404 || res.status === 410 || res.status >= 500) {
            throw new Error('HTTP ' + res.status);
          }
          if (!res.ok) {
            return res.json().catch(function () { return null; }).then(function (body) {
              const msg = body && body.error && (body.error.message || body.error);
              throw Object.assign(new Error(msg || ('HTTP ' + res.status)), { fatal: true });
            });
          }
          rememberHost(hosts[i]);
          return res.json().then(parseRoute);
        })
        .catch(function (err) {
          if (err.fatal) {
            console.warn('路线查询被拒：', err.message, '（多半是 Key 不对或额度用完）');
            return null;
          }
          if (i + 1 < hosts.length) return attempt(i + 1);   // 换下一个域名再试
          console.warn('路线查询失败：', err.message, a.name, '->', b.name);
          return null;
        });
    }

    return attempt(0);
  }

  /** 把 ORS 的 GeoJSON 转成本项目的路段格式（导出出来单独测） */
  function parseRoute(geojson) {
    const feature = geojson && geojson.features && geojson.features[0];
    if (!feature) return null;
    const sum = feature.properties && feature.properties.summary;
    if (!sum || !sum.duration) return null;

    // GeoJSON 是 [经度, 纬度]，Leaflet 要 [纬度, 经度]
    const path = ((feature.geometry && feature.geometry.coordinates) || []).map(function (c) {
      return [c[1], c[0]];
    });

    return {
      minutes: Math.max(1, Math.round(sum.duration / 60)),
      km: Math.round((sum.distance / 1000) * 10) / 10,
      path: path,
      estimated: false
    };
  }

  /* ---------- 地点搜索（Photon） ---------- */
  function attachAutocomplete(input, onPlace) {
    if (!input) return null;

    const box = document.createElement('div');
    box.className = 'osm-suggest';
    box.hidden = true;
    input.parentNode.appendChild(box);

    let timer = null;
    let controller = null;

    function close() { box.hidden = true; box.innerHTML = ''; }

    function search(q) {
      if (controller) controller.abort();
      controller = new AbortController();

      fetch(PHOTON + '?limit=6&lang=en&q=' + encodeURIComponent(q), { signal: controller.signal })
        .then(function (r) { return r.json(); })
        .then(function (data) { renderList((data && data.features) || []); })
        .catch(function (err) {
          if (err.name !== 'AbortError') console.warn('地点搜索失败', err);
        });
    }

    function renderList(features) {
      box.innerHTML = '';
      if (!features.length) {
        box.appendChild(U.el('div', { class: 'osm-suggest-empty', text: '没搜到，换个说法试试（英文名通常更准）' }));
        box.hidden = false;
        return;
      }
      features.forEach(function (f) {
        const place = toPlace(f);
        box.appendChild(U.el('button', {
          type: 'button',
          class: 'osm-suggest-item',
          onclick: function () {
            onPlace(place);
            close();
          }
        }, [
          U.el('span', { class: 'osm-suggest-name', text: place.name }),
          U.el('span', { class: 'osm-suggest-addr', text: place.address })
        ]));
      });
      box.hidden = false;
    }

    input.addEventListener('input', function () {
      const q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { close(); return; }
      timer = setTimeout(function () { search(q); }, 300);
    });

    input.addEventListener('blur', function () {
      setTimeout(close, 200);           // 给点击留出时间
    });

    return { close: close };
  }

  /** Photon 的一条结果 -> 本项目的地点对象 */
  function toPlace(feature) {
    const p = feature.properties || {};
    const coords = (feature.geometry && feature.geometry.coordinates) || [0, 0];
    const addr = [
      [p.housenumber, p.street].filter(Boolean).join(' '),
      p.city || p.district,
      p.state,
      p.country
    ].filter(Boolean).join(', ');

    return {
      name: p.name || p.street || addr || '未命名地点',
      address: addr,
      lat: coords[1],
      lng: coords[0],
      placeId: p.osm_type && p.osm_id ? p.osm_type + p.osm_id : '',
      types: osmTypes(p)
    };
  }

  /** 把 OSM 的标签翻译成本项目认识的类型关键字 */
  function osmTypes(p) {
    const key = p.osm_key;
    const value = p.osm_value;
    const out = [];
    if (key === 'amenity') {
      if (['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'ice_cream'].indexOf(value) >= 0) out.push('restaurant');
      if (value === 'bakery') out.push('bakery');
    }
    if (key === 'shop') {
      out.push(value === 'bakery' ? 'bakery' : 'store');
      if (value === 'mall') out.push('shopping_mall');
    }
    if (key === 'tourism') {
      if (['hotel', 'motel', 'hostel', 'guest_house', 'apartment'].indexOf(value) >= 0) out.push('lodging');
      if (['attraction', 'viewpoint', 'theme_park', 'zoo'].indexOf(value) >= 0) out.push('tourist_attraction');
      if (value === 'museum') out.push('museum');
    }
    if (key === 'leisure' && ['park', 'garden', 'nature_reserve'].indexOf(value) >= 0) out.push('park');
    if (key === 'natural') out.push('natural_feature');
    if (key === 'aeroway') out.push('airport');
    if (key === 'railway' || key === 'public_transport') out.push('transit_station');
    return out;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  global.MapsOSM = {
    loadApi: loadApi,
    initMap: initMap,
    isReady: isReady,
    renderDay: renderDay,
    focusStop: focusStop,
    resize: resize,
    fetchLegs: fetchLegs,
    attachAutocomplete: attachAutocomplete,
    escapeHtml: escapeHtml,
    // 导出给测试用
    parseRoute: parseRoute,
    hostOrder: hostOrder,
    ORS_HOSTS: ORS_HOSTS,
    toPlace: toPlace
  };
})(window);
