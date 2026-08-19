/*
 * Google Maps 接入层：
 *  - 动态载入 Maps JS API（key 由用户自己填，存本地）
 *  - 每天的地点打点 + 按顺序连线（真实路线，拿不到就退化成直线）
 *  - 用 Directions API 算「路上多久 / 多远」，结果缓存起来省配额
 *  - 地点搜索用 Places Autocomplete，自动带回经纬度
 */
(function (global) {
  'use strict';

  const U = global.Util;

  let map = null;
  let apiReady = false;
  let loadPromise = null;
  let markers = [];
  let polylines = [];
  let infoWindow = null;
  let directionsService = null;
  let placesReady = false;

  function isReady() { return apiReady && !!map; }

  function loadApi(key) {
    if (loadPromise) return loadPromise;
    if (!key) return Promise.reject(new Error('缺少 Google Maps API Key'));

    loadPromise = new Promise(function (resolve, reject) {
      const cbName = '__usRoutineMapsReady';
      global[cbName] = function () {
        apiReady = true;
        resolve();
      };
      const script = document.createElement('script');
      script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) +
        '&libraries=places,geometry&language=zh-CN&region=US&callback=' + cbName;
      script.async = true;
      script.onerror = function () {
        loadPromise = null;
        reject(new Error('Google Maps 脚本加载失败（检查 Key、网络或域名白名单）'));
      };
      document.head.appendChild(script);
    });
    return loadPromise;
  }

  function initMap(container) {
    if (!apiReady) return null;
    map = new google.maps.Map(container, {
      center: { lat: 37.7879, lng: -122.4103 },
      zoom: 12,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: 'greedy',
      styles: [
        { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] }
      ]
    });
    directionsService = new google.maps.DirectionsService();
    infoWindow = new google.maps.InfoWindow();
    placesReady = !!(google.maps.places && google.maps.places.Autocomplete);
    return map;
  }

  function clearOverlays() {
    markers.forEach(function (m) { m.setMap(null); });
    polylines.forEach(function (p) { p.setMap(null); });
    markers = [];
    polylines = [];
  }

  function pinIcon(color, label, active) {
    return {
      path: 'M 0,0 C -2,-20 -10,-22 -10,-30 A 10,10 0 1,1 10,-30 C 10,-22 2,-20 0,0 z',
      fillColor: color,
      fillOpacity: 1,
      strokeColor: active ? '#111827' : '#ffffff',
      strokeWeight: active ? 3 : 2,
      scale: active ? 1.15 : 0.95,
      labelOrigin: new google.maps.Point(0, -30)
    };
  }

  /**
   * 在地图上画出一天的行程：编号图钉 + 顺序连线
   * @param {Object} day
   * @param {Array} items  Schedule.computeDay(...).items
   */
  function renderDay(day, items, options) {
    if (!isReady()) return;
    options = options || {};
    clearOverlays();

    const bounds = new google.maps.LatLngBounds();
    let hasPoint = false;

    items.forEach(function (item, i) {
      const stop = item.stop;
      if (stop.lat == null || stop.lng == null) return;
      hasPoint = true;
      const cat = U.CATEGORIES[stop.category] || U.CATEGORIES.other;
      const pos = { lat: Number(stop.lat), lng: Number(stop.lng) };
      bounds.extend(pos);

      const marker = new google.maps.Marker({
        position: pos,
        map: map,
        title: stop.name,
        zIndex: options.activeStopId === stop.id ? 999 : i,
        icon: pinIcon(cat.color, String(i + 1), options.activeStopId === stop.id),
        label: { text: String(i + 1), color: '#ffffff', fontSize: '12px', fontWeight: '700' }
      });

      marker.addListener('click', function () {
        infoWindow.setContent(
          '<div style="font:13px/1.6 system-ui;max-width:230px">' +
          '<div style="font-weight:700;margin-bottom:2px">' + cat.icon + ' ' + escapeHtml(stop.name) + '</div>' +
          '<div style="color:#475569">' + U.toClock(item.startAt) + ' – ' + U.toClock(item.departAt) +
          '（停留 ' + U.toDuration(item.stayMin) + '）</div>' +
          (stop.address ? '<div style="color:#94a3b8;margin-top:2px">' + escapeHtml(stop.address) + '</div>' : '') +
          '</div>'
        );
        infoWindow.open(map, marker);
        if (options.onMarkerClick) options.onMarkerClick(stop.id);
      });

      markers.push(marker);
    });

    // 连线：优先用 Directions 返回的真实路线，没有就画虚线直线
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1].stop;
      const b = items[i].stop;
      if (a.lat == null || b.lat == null) continue;
      const mode = items[i].stop.arriveMode || 'DRIVING';
      const cached = global.Store.getLeg(a, b, mode);
      let path = null;
      if (cached && cached.encoded && google.maps.geometry) {
        try {
          path = google.maps.geometry.encoding.decodePath(cached.encoded);
        } catch (e) { path = null; }
      }
      const realRoute = !!path;
      if (!path) {
        path = [
          { lat: Number(a.lat), lng: Number(a.lng) },
          { lat: Number(b.lat), lng: Number(b.lng) }
        ];
      }
      const line = new google.maps.Polyline({
        path: path,
        map: map,
        strokeColor: '#2563eb',
        strokeOpacity: realRoute ? 0.85 : 0,
        strokeWeight: realRoute ? 5 : 3,
        icons: realRoute ? null : [{
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, scale: 3, strokeColor: '#94a3b8' },
          offset: '0',
          repeat: '12px'
        }],
        zIndex: 1
      });
      polylines.push(line);
    }

    if (hasPoint && !options.keepViewport) {
      map.fitBounds(bounds, { top: 60, bottom: 60, left: 60, right: 60 });
      if (items.filter(function (it) { return it.stop.lat != null; }).length === 1) map.setZoom(14);
    }
  }

  function focusStop(stop) {
    if (!isReady() || stop.lat == null) return;
    map.panTo({ lat: Number(stop.lat), lng: Number(stop.lng) });
    if (map.getZoom() < 14) map.setZoom(15);
  }

  /**
   * 逐段向 Directions API 请求真实耗时与路线，写入缓存。
   * @returns {Promise<number>} 新抓到的段数
   */
  function fetchLegs(day, onProgress) {
    if (!isReady() || !directionsService) return Promise.resolve(0);
    const stops = day.stops || [];
    const jobs = [];
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1];
      const b = stops[i];
      const mode = b.arriveMode || 'DRIVING';
      if (a.lat == null || b.lat == null) continue;
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
          return new Promise(function (r) { setTimeout(r, 120); }); // 轻微限速
        });
      });
    }, Promise.resolve()).then(function () { return done; });
  }

  function requestLeg(a, b, mode) {
    return new Promise(function (resolve) {
      const request = {
        origin: { lat: Number(a.lat), lng: Number(a.lng) },
        destination: { lat: Number(b.lat), lng: Number(b.lng) },
        travelMode: mode
      };
      if (mode === 'TRANSIT') {
        request.transitOptions = { departureTime: new Date() };
      }
      directionsService.route(request, function (res, status) {
        if (status !== 'OK' || !res.routes || !res.routes.length) {
          console.warn('Directions 失败：', status, a.name, '->', b.name);
          resolve(null);
          return;
        }
        const route = res.routes[0];
        const leg = route.legs[0];
        resolve({
          minutes: Math.round(leg.duration.value / 60),
          km: Math.round((leg.distance.value / 1000) * 10) / 10,
          encoded: route.overview_polyline || (route.overview_path && google.maps.geometry
            ? google.maps.geometry.encoding.encodePath(route.overview_path) : null),
          estimated: false
        });
      });
    });
  }

  /** 给输入框挂上 Places 自动补全，选中后回填名称 / 地址 / 经纬度 */
  function attachAutocomplete(input, onPlace) {
    if (!isReady() || !placesReady) return null;
    const ac = new google.maps.places.Autocomplete(input, {
      fields: ['name', 'formatted_address', 'geometry', 'place_id', 'types'],
      componentRestrictions: { country: ['us'] }
    });
    ac.addListener('place_changed', function () {
      const place = ac.getPlace();
      if (!place || !place.geometry) return;
      onPlace({
        name: place.name || place.formatted_address,
        address: place.formatted_address || '',
        lat: place.geometry.location.lat(),
        lng: place.geometry.location.lng(),
        placeId: place.place_id || '',
        types: place.types || []
      });
    });
    return ac;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  global.Maps = {
    loadApi: loadApi,
    initMap: initMap,
    isReady: isReady,
    renderDay: renderDay,
    focusStop: focusStop,
    fetchLegs: fetchLegs,
    attachAutocomplete: attachAutocomplete,
    escapeHtml: escapeHtml
  };
})(window);
