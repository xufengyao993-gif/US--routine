/* 极简 RTDB 替身：内存里一棵树，支持按路径 set / update / get */
const http = require('http');
let tree = {};
const seg = p => String(p).split('/').filter(Boolean);
function setIn(path, value) {
  const parts = seg(path);
  if (!parts.length) { tree = value || {}; return; }
  let node = tree;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === null) delete node[last]; else node[last] = value;
}
function getIn(path) {
  let node = tree;
  for (const k of seg(path)) {
    if (node == null || typeof node !== 'object') return null;
    node = node[k];
  }
  return node === undefined ? null : node;
}
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let msg = {};
    try { msg = JSON.parse(body || '{}'); } catch (e) {}
    if (msg.op === 'set') setIn(msg.path, msg.value);
    else if (msg.op === 'update') Object.keys(msg.value || {}).forEach(k => setIn(msg.path + '/' + k, msg.value[k]));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, value: msg.op === 'get' ? getIn(msg.path) : null }));
  });
});
server.listen(8124, '127.0.0.1', () => console.log('fakedb on 8124'));
