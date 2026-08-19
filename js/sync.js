/*
 * 多人实时同步（Firebase Realtime Database）。
 *
 * 设计要点：
 *  - 本地优先：所有编辑先改本地、立刻重绘，再把「只包含改动字段的补丁」推上去。
 *    网断了也能继续编辑，Firebase SDK 会在重连后自动补传。
 *  - 补丁按路径写：days/<dayId>/stops/<stopId>/name 这种。两个人改不同的点永远不冲突，
 *    改同一个字段才是后写的赢。
 *  - 没配 Firebase 时整体降级为「本地模式」，功能照常，只是不同步。
 *  - 在线成员和「谁正在编辑哪个点」用 presence 节点，断线自动清理。
 */
(function (global) {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const NAME_KEY = 'us-routine.my-name';
  const CLIENT_KEY = 'us-routine.client-id';

  const PALETTE = ['#2563eb', '#f97316', '#16a34a', '#db2777', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626'];

  let fb = null;          // {app, db, auth, refs...}
  let mode = 'local';     // local | connecting | online | offline | error
  let tripId = null;
  let handlers = {};
  let presenceRef = null;
  let heartbeat = null;
  let me = null;
  let lastError = null;

  function clientId() {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  }

  function myName() {
    let n = localStorage.getItem(NAME_KEY);
    if (!n) {
      n = '旅伴' + Math.floor(10 + Math.random() * 89);
      localStorage.setItem(NAME_KEY, n);
    }
    return n;
  }

  function setName(name) {
    const clean = (name || '').trim().slice(0, 12) || myName();
    localStorage.setItem(NAME_KEY, clean);
    if (me) me.name = clean;
    if (presenceRef && fb) fb.set(fb.child(presenceRef, 'name'), clean).catch(noop);
    return clean;
  }

  function colorFor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function noop() {}

  function getMode() { return mode; }
  function isOnline() { return mode === 'online'; }
  function getMe() { return me; }
  function getError() { return lastError; }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    if (handlers.onStatus) handlers.onStatus(mode, lastError);
  }

  /** Firebase 不接受 undefined，统一清成 null / 丢弃 */
  function clean(value) {
    if (value === undefined) return null;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(clean);
    const out = {};
    Object.keys(value).forEach(function (k) {
      if (value[k] === undefined) return;
      out[k] = clean(value[k]);
    });
    return out;
  }

  /**
   * @param {Object} opts {config, tripId, onTrip, onPresence, onStatus}
   * @returns {Promise<string>} 最终模式
   */
  function init(opts) {
    handlers = opts || {};
    tripId = opts.tripId;
    me = { id: clientId(), name: myName(), color: colorFor(clientId()) };

    const cfg = opts.config;
    if (!cfg || !cfg.apiKey || !cfg.databaseURL || !tripId) {
      setMode('local');
      return Promise.resolve('local');
    }

    setMode('connecting');
    return Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js'),
      import(SDK + 'firebase-database.js')
    ]).then(function (mods) {
      const appMod = mods[0], authMod = mods[1], dbMod = mods[2];
      const app = appMod.initializeApp(cfg);
      const auth = authMod.getAuth(app);
      const db = dbMod.getDatabase(app);

      fb = {
        app: app, db: db, auth: auth,
        ref: dbMod.ref, child: dbMod.child, set: dbMod.set, update: dbMod.update,
        onValue: dbMod.onValue, onDisconnect: dbMod.onDisconnect, remove: dbMod.remove,
        serverTimestamp: dbMod.serverTimestamp
      };

      return authMod.signInAnonymously(auth).then(function () {
        const root = dbMod.ref(db, 'trips/' + tripId);

        // 连接状态
        dbMod.onValue(dbMod.ref(db, '.info/connected'), function (snap) {
          if (snap.val() === true) {
            setMode('online');
            armPresence(dbMod, db);
          } else {
            setMode('offline');
          }
        });

        // 行程数据
        dbMod.onValue(dbMod.child(root, 'data'), function (snap) {
          const val = snap.val();
          if (handlers.onTrip) handlers.onTrip(val);
        }, function (err) {
          lastError = err.message;
          setMode('error');
        });

        // 在线成员
        dbMod.onValue(dbMod.child(root, 'presence'), function (snap) {
          const val = snap.val() || {};
          const now = Date.now();
          const list = Object.keys(val).map(function (k) {
            return Object.assign({ id: k }, val[k]);
          }).filter(function (p) {
            return !p.ts || now - p.ts < 5 * 60 * 1000;   // 5 分钟没心跳就当离开了
          });
          if (handlers.onPresence) handlers.onPresence(list);
        }, noop);

        return mode;
      });
    }).catch(function (err) {
      console.error('同步初始化失败', err);
      lastError = err.message;
      setMode('error');
      return 'error';
    });
  }

  function armPresence(dbMod, db) {
    if (!tripId) return;
    presenceRef = dbMod.ref(db, 'trips/' + tripId + '/presence/' + me.id);
    dbMod.onDisconnect(presenceRef).remove();
    dbMod.set(presenceRef, { name: me.name, color: me.color, ts: Date.now(), editing: null }).catch(noop);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(function () {
      if (presenceRef) dbMod.set(dbMod.child(presenceRef, 'ts'), Date.now()).catch(noop);
    }, 60 * 1000);
  }

  /** 告诉别人我在编辑哪个点（传 null 表示结束编辑） */
  function setEditing(stopId) {
    if (!fb || !presenceRef) return;
    fb.set(fb.child(presenceRef, 'editing'), stopId || null).catch(noop);
  }

  /**
   * 推一批改动。patch 的 key 是相对 trips/<id>/data 的路径。
   * 例：{'days/d1/stops/s3/stayMin': 45, 'days/d1/stops/s3/updatedAt': 1699...}
   */
  function push(patch) {
    if (!fb || !tripId) return Promise.resolve(false);
    const body = clean(patch);
    body['updatedAt'] = Date.now();
    body['updatedBy'] = me.name;
    return fb.update(fb.ref(fb.db, 'trips/' + tripId + '/data'), body)
      .then(function () { return true; })
      .catch(function (err) {
        console.warn('同步写入失败', err);
        lastError = err.message;
        return false;
      });
  }

  /** 整份行程覆盖上去（新建行程 / 导入 JSON 时用） */
  function replaceAll(trip) {
    if (!fb || !tripId) return Promise.resolve(false);
    return fb.set(fb.ref(fb.db, 'trips/' + tripId + '/data'), clean(trip))
      .then(function () { return true; })
      .catch(function (err) {
        console.warn('同步覆盖失败', err);
        lastError = err.message;
        return false;
      });
  }

  global.Sync = {
    init: init,
    push: push,
    replaceAll: replaceAll,
    setEditing: setEditing,
    isOnline: isOnline,
    getMode: getMode,
    getMe: getMe,
    getError: getError,
    setName: setName,
    myName: myName
  };
})(window);
