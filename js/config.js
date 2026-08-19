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

  /**
   * 解析用户从 Firebase 控制台复制来的配置。
   *
   * 控制台给的是 JS 对象字面量，不是 JSON：键没引号、可能带尾逗号、可能是单引号，
   * 还经常连 import 语句和 initializeApp 一起被复制进来。这里一律吃下去：
   *   1. 从 apiKey 出发，大括号配对切出真正的配置对象（避开 import { ... } 那种干扰）
   *   2. 先按标准 JSON 试一次
   *   3. 不行再规范化（补键引号、单引号转双引号、去注释和尾逗号）后重试
   */
  function parseFirebase(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    const block = extractObject(text);
    if (!block) {
      throw new Error('没找到配置内容。请把控制台里 firebaseConfig 那一段（含大括号）整个复制过来。');
    }

    try {
      return JSON.parse(block);
    } catch (e) { /* 多半是 JS 对象字面量，往下规范化 */ }

    const normalized = block
      .replace(/\/\*[\s\S]*?\*\//g, '')                       // 块注释
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')                      // 行注释（别误伤 https://）
      .replace(/'((?:[^'\\]|\\.)*)'/g, function (m, inner) {    // 单引号 -> 双引号
        return '"' + inner.replace(/"/g, '\\"') + '"';
      })
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')     // 给键补引号
      .replace(/,(\s*[}\]])/g, '$1');                            // 尾逗号

    try {
      return JSON.parse(normalized);
    } catch (e) {
      throw new Error('这段内容看不懂（' + e.message + '）。确认复制的是 firebaseConfig 后面大括号里的全部内容。');
    }
  }

  /** 以 apiKey 为锚点，向前找到起始大括号，再配对找到收尾（跳过字符串里的括号） */
  function extractObject(text) {
    const anchor = text.search(/apiKey/);
    if (anchor < 0) return null;
    const start = text.lastIndexOf('{', anchor);
    if (start < 0) return null;

    let depth = 0;
    let quote = null;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  function hasValues(cfg) {
    return !!(cfg && (cfg.mapsApiKey || cfg.orsApiKey || cfg.mapProvider ||
      (cfg.firebase && cfg.firebase.apiKey)));
  }

  function normalize(cfg) {
    return {
      mapProvider: (cfg && cfg.mapProvider) || '',      // '' | 'osm' | 'google'
      orsApiKey: (cfg && cfg.orsApiKey) || '',          // OpenRouteService
      mapsApiKey: (cfg && cfg.mapsApiKey) || '',        // Google Maps
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
    parseFirebase: parseFirebase,
    save: save,
    clearLocal: clearLocal,
    getSource: function () { load(); return source; },
    hasValues: hasValues,
    shareSuffix: shareSuffix
  };
})(window);
