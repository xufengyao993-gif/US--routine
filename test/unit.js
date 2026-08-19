global.window = global;
global.crypto = require('crypto').webcrypto;
const R = require('path').join(__dirname, '..', 'js') + '/';
require(R+'util.js'); require(R+'model.js'); require(R+'schedule.js'); require(R+'data.js'); require(R+'config.js');
const { Schedule, Util, Model, SampleTrip } = global;
let n = 0; const ok = (c, m) => { n++; if (!c) { console.error('❌ ' + m); process.exitCode = 1; } };

/* --- 1. v1(数组) -> v2(键值表) 迁移 --- */
const v2 = Model.migrate(JSON.parse(JSON.stringify(SampleTrip)));
ok(v2.version === 2, '版本升到 2');
ok(!Array.isArray(v2.days) && typeof v2.days === 'object', 'days 变成键值表');
const days = Model.dayList(v2);
ok(days.length === 3, '3 天');
ok(days[0].id === 'day-sf1' && days[2].id === 'day-la1', '天的顺序保持不变');
const d1 = Model.stopList(days[0]);
ok(d1.length === 10, '第一天 10 个点，实际 ' + d1.length);
ok(d1[0].name.indexOf('Hotel Zeppelin') === 0 && d1[3].category === 'food', '地点顺序保持不变');
ok(Model.migrate(v2) === v2, '已是 v2 的不重复迁移');

/* --- 2. 排序号：插队不影响别人 --- */
const stops = Model.stopList(days[0]);
const mid = Model.orderForMove(stops, 5, 1);   // 把第 6 个挪到第 2 位
ok(mid > stops[0].order && mid < stops[1].order, '新 order 落在前两个之间: ' + mid);
const applied = stops.map(s => s.id === stops[5].id ? Object.assign({}, s, {order: mid}) : s)
  .sort((a,b) => a.order - b.order).map(s => s.id);
ok(applied[1] === stops[5].id, '重排后确实到了第 2 位');
ok(applied[0] === stops[0].id && applied[2] === stops[1].id, '其他点相对顺序不变');

// 移到头 / 尾
ok(Model.orderForMove(stops, 3, 0) < stops[0].order, '移到最前');
ok(Model.orderForMove(stops, 0, stops.length - 1) > stops[stops.length-1].order, '移到最后');

// order 撞死时返回 null，触发重排
const tight = [{id:'a',order:1},{id:'b',order:2},{id:'c',order:3}];
// a 和 b 的 order 已经贴到浮点精度极限，中间塞不下第三个值
ok(Model.orderForMove([{id:'a',order:1},{id:'b',order:1.0000000000000002},{id:'c',order:5}], 2, 1) === null,
   'order 精度用尽时返回 null（交给调用方重排）');
const re = Model.reindex({a:{id:'a',order:5},b:{id:'b',order:1}});
ok(re.b === 1024 && re.a === 2048, 'reindex 按顺序重排步长 1024');

/* --- 3. 并发编辑不互相覆盖（模拟两人各改一个点） --- */
const trip = Model.migrate(JSON.parse(JSON.stringify(SampleTrip)));
const dayId = Model.dayList(trip)[0].id;
const ids = Model.stopList(Model.dayList(trip)[0]).map(s => s.id);
// A 改第 1 个点的停留时间；B 同时把第 5 个点删掉 —— 补丁路径互不相交
const patchA = {}; patchA['days/'+dayId+'/stops/'+ids[1]+'/stayMin'] = 30;
const patchB = {}; patchB['days/'+dayId+'/stops/'+ids[4]] = null;
const paths = Object.keys(patchA).concat(Object.keys(patchB));
ok(new Set(paths).size === paths.length && !paths[0].startsWith(paths[1]) && !paths[1].startsWith(paths[0]),
   '两个人的写入路径互不包含，不会覆盖');

/* --- 4. 排时间引擎（回归） --- */
const r = Schedule.computeDay({startTime:'09:00', stops: Model.stopList(Model.dayList(v2)[0])}, () => null);
ok(Util.toClock(r.summary.leaveHomeAt) === '09:00', '9 点出门');
ok(r.summary.foodCount === 2, '两顿饭');
const r2 = Schedule.computeDay({startTime:'09:00', stops:[
  {name:'A', lat:37.78,lng:-122.41, stayMin:0},
  {name:'B', lat:37.80,lng:-122.47, stayMin:120},
  {name:'C', lat:37.79,lng:-122.40, stayMin:60, fixedStart:'10:30'}
]}, () => ({minutes:20, km:8}));
ok(r2.items[2].lateBy === 70, '迟到 70 分钟');
ok(r2.items[2].leg.latestDeparture === 10*60+10, '最晚 10:10 出发');
const r3 = Schedule.computeDay({startTime:'09:00', stops:[
  {name:'A', lat:37.78,lng:-122.41, stayMin:0},
  {name:'B', lat:37.79,lng:-122.40, stayMin:60, fixedStart:'12:00'}
]}, () => ({minutes:20, km:8}));
ok(r3.items[1].waitMin === 160 && r3.items[1].startAt === 720, '早到产生空档');

/* --- 5. 撤销：反操作补丁 --- */
const t5 = Model.migrate(JSON.parse(JSON.stringify(SampleTrip)));
const d5 = Model.dayList(t5)[0];
const s5 = Model.stopList(d5)[1];
const p5 = 'days/' + d5.id + '/stops/' + s5.id;

// 改一个字段
const editPatch = {}; editPatch[p5 + '/stayMin'] = 15;
const editInv = Model.inverseOf(t5, editPatch);
ok(editInv[p5 + '/stayMin'] === s5.stayMin, '反操作记下了改之前的值');
Object.keys(editPatch).forEach(k => Model.setAtPath(t5, k, editPatch[k]));
ok(Model.getAtPath(t5, p5 + '/stayMin') === 15, '补丁生效');
Object.keys(editInv).forEach(k => Model.setAtPath(t5, k, editInv[k]));
ok(Model.getAtPath(t5, p5 + '/stayMin') === s5.stayMin, '撤销后还原');

// 删一个地点再撤销，整条数据要回来
const delPatch = {}; delPatch[p5] = null;
const delInv = Model.inverseOf(t5, delPatch);
Object.keys(delPatch).forEach(k => Model.setAtPath(t5, k, delPatch[k]));
ok(Model.getAtPath(t5, p5) === null, '地点已删除');
ok(Model.stopList(Model.dayList(t5)[0]).length === 9, '删除后少一个');
Object.keys(delInv).forEach(k => Model.setAtPath(t5, k, delInv[k]));
ok(Model.getAtPath(t5, p5 + '/name') === s5.name, '撤销删除后整条数据回来了');
ok(Model.stopList(Model.dayList(t5)[0])[1].id === s5.id, '而且回到原来的位置');

// 深拷贝：拿到的旧值不能和现存对象共用引用
const snap = Model.getAtPath(t5, p5);
Model.setAtPath(t5, p5 + '/name', '改过了');
ok(snap.name === s5.name, '取出的旧值是深拷贝，不会被后续改动带走');

/* --- 6. 导出结构 --- */
const plain = Model.toPlain(v2);
ok(Array.isArray(plain.days) && Array.isArray(plain.days[0].stops), '导出回数组结构');
ok(plain.days[0].stops[0].name === d1[0].name, '导出顺序正确');
ok(Model.newTripId().length === 24, '行程 ID 24 位');

/* --- 7. Firebase 配置解析：控制台原样复制的各种形态都要吃下去 --- */
const P = global.Config.parseFirebase;
const want = (o, note) => ok(o && o.apiKey === 'AIzaSyTEST' && o.databaseURL === 'https://x-default-rtdb.firebaseio.com', note);

// 标准 JSON
want(P('{"apiKey":"AIzaSyTEST","databaseURL":"https://x-default-rtdb.firebaseio.com"}'), '标准 JSON');

// 控制台实际给的样子：键没引号 + const 前缀 + 分号
want(P(`const firebaseConfig = {
  apiKey: "AIzaSyTEST",
  authDomain: "x.firebaseapp.com",
  databaseURL: "https://x-default-rtdb.firebaseio.com",
  projectId: "x",
  appId: "1:2:web:3"
};`), 'JS 对象字面量（键无引号）');

// 整段 SDK 代码一起复制 —— import { initializeApp } 那个大括号不能被当成配置
want(P(`import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyTEST",
  databaseURL: "https://x-default-rtdb.firebaseio.com",
};
const app = initializeApp(firebaseConfig);`), '整段 SDK 代码（含 import 和注释、尾逗号）');

// 单引号
want(P("var firebaseConfig = { apiKey: 'AIzaSyTEST', databaseURL: 'https://x-default-rtdb.firebaseio.com' }"), '单引号');

// 只复制了大括号里面的内容（没带括号）时应给出可读的错误
let threw = null;
try { P('apiKey: "AIzaSyTEST"'); } catch (e) { threw = e.message; }
ok(threw && threw.indexOf('大括号') >= 0, '没带大括号时提示要连大括号一起复制');

threw = null;
try { P('{ "foo": 1 }'); } catch (e) { threw = e.message; }
ok(threw && threw.indexOf('没找到') >= 0, '内容里没有 apiKey 时明确报错');

ok(P('') === null, '空输入返回 null');

// 值里带特殊字符不能被规范化搞坏
const tricky = P(`{ apiKey: "AIzaSyTEST", databaseURL: "https://x-default-rtdb.firebaseio.com", authDomain: "a-b.firebaseapp.com" }`);
ok(tricky.authDomain === 'a-b.firebaseapp.com', '值里的 // 和连字符不受影响');

console.log(process.exitCode ? '有断言失败' : `全部 ${n} 条断言通过 ✅`);
