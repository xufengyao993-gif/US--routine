const API = 'http://127.0.0.1:8124/';
function call(op, path, value) {
  return fetch(API, { method: 'POST', body: JSON.stringify({ op, path, value }) })
    .then(r => r.json()).then(j => j.value);
}
export function initializeApp() { return {}; }
export function getAuth() { return {}; }
export function signInAnonymously() { return Promise.resolve({ user: { uid: 'u' + Math.random().toString(36).slice(2) } }); }
export function getDatabase() { return {}; }
export function ref(db, path) { return { path: path }; }
export function child(r, key) { return { path: r.path + '/' + key }; }
export function serverTimestamp() { return Date.now(); }
export function set(r, value) { return call('set', r.path, value === undefined ? null : value); }
export function update(r, patch) { return call('update', r.path, patch); }
export function remove(r) { return call('set', r.path, null); }
export function onDisconnect() { return { remove: () => Promise.resolve() }; }
export function onValue(r, cb) {
  if (r.path === '.info/connected') { setTimeout(() => cb({ val: () => true }), 10); return () => {}; }
  let last;
  const tick = () => call('get', r.path).then(v => {
    const s = JSON.stringify(v);
    if (s !== last) { last = s; cb({ val: () => v }); }
  }).catch(() => {});
  tick();
  setInterval(tick, 150);
  return () => {};
}
