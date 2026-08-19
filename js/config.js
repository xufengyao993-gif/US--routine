/* 配置解析：分享链接 > 本地设置 > 部署注入 */
(function (global) {
  'use strict';

  const LS_KEY = 'us-routine.config.v2';
  let resolved = null;
  let source = 'none';

  function decode(b64) {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(b64.replace(/-/g, '+').replace(/_/g, '/')))));
    } catch (e) {
      console.warn('链接里的配置解不开', e);
      return null;
    }
  }

  function encode(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function hasValues(cfg) {
    return !!(cfg && (cfg.mapsApiKey || (cfg.firebase && cfg.firebase.apiKey)));
  }

  function normalize(cfg) {
    return {
      mapsApiKey: (cfg && cfg.mapsApiKey) || '',
      firebase: Object.assign({
        apiKey: '', authDomain: '', databaseURL: '', projectId: '', appId: ''
      }, (cfg && cfg.firebase) || {})
    };
  }

  function load() {
    if (resolved) return resolved;

    // 1) 分享链接里带的配置：收下并存起来，然后从地址栏抹掉
    const hash = location.hash || '';
    const m = hash.match(/[#&]cfg=([A-Za-z0-9\-_]+)/);
    if (m) {
      const fromLink = decode(m[1]);
      if (hasValues(fromLink)) {
        localStorage.setItem(LS_KEY, JSON.stringify(normalize(fromLink)));
        const cleanHash = hash.replace(/[#&]cfg=[A-Za-z0-9\-_]+/, '');
        history.replaceState(null, '', location.pathname + location.search + (cleanHash === '#' ? '' : cleanHash));
      }
    }

    // 2) 本地设置
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const local = normalize(JSON.parse(raw));
        if (hasValues(local)) {
          resolved = local;
          source = 'local';
          return resolved;
        }
      }
    } catch (e) { /* 忽略坏数据 */ }

    // 3) 部署注入
    const baked = normalize(global.APP_CONFIG);
    resolved = baked;
    source = hasValues(baked) ? 'deploy' : 'none';
    return resolved;
  }

  function save(cfg) {
    const norm = normalize(cfg);
    localStorage.setItem(LS_KEY, JSON.stringify(norm));
    resolved = norm;
    source = 'local';
    return norm;
  }

  function clearLocal() {
    localStorage.removeItem(LS_KEY);
    resolved = null;
    source = 'none';
    return load();
  }

  /** 部署自带配置时不用把 Key 塞进链接，否则塞进去让朋友免配置 */
  function shareSuffix() {
    if (source === 'deploy') return '';
    const cfg = load();
    if (!hasValues(cfg)) return '';
    return '#cfg=' + encode(cfg);
  }

  global.Config = {
    load: load,
    save: save,
    clearLocal: clearLocal,
    getSource: function () { load(); return source; },
    hasValues: hasValues,
    shareSuffix: shareSuffix
  };
})(window);
