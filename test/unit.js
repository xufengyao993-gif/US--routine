global.window = global;
global.crypto = require('crypto').webcrypto;
const R = require('path').join(__dirname, '..', 'js') + '/';
require(R+'util.js'); require(R+'model.js'); require(R+'schedule.js'); require(R+'data.js'); require(R+'config.js'); require(R+'store.js'); require(R+'maps-osm.js'); require(R+'maps.js');
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

/* --- 7. 日期：本地时区，不能被 toISOString 带歪 --- */
ok(Util.addDays('2026-09-12', 1) === '2026-09-13', '加一天：' + Util.addDays('2026-09-12', 1));
ok(Util.addDays('2026-09-30', 1) === '2026-10-01', '跨月');
ok(Util.addDays('2026-12-31', 1) === '2027-01-01', '跨年');
ok(Util.addDays('2026-03-01', -1) === '2026-02-28', '往回一天');
ok(Util.addDays('2026-09-12', 0) === '2026-09-12', '加 0 天不变');
ok(/^\d{4}-\d{2}-\d{2}$/.test(Util.addDays(null, 0)), '空值时以今天为准');
// 夏令时切换当天（美国 2026-03-08 凌晨 2 点跳到 3 点）也要老实 +1
ok(Util.addDays('2026-03-07', 1) === '2026-03-08', '夏令时切换前一天');
ok(Util.addDays('2026-03-08', 1) === '2026-03-09', '夏令时切换当天');

/* --- 8. 按固定时间重排 --- */
const mk = (name, fixed) => ({ id: name, name: name, fixedStart: fixed || '' });

// 顺序颠倒：晚饭排在了午饭前面
let list = [mk('酒店'), mk('晚饭', '18:30'), mk('午饭', '12:00'), mk('景点')];
ok(Model.fixedOutOfOrder(list) === 1, '检测出 1 处顺序颠倒');
let sorted = Model.sortByFixedTime(list).map(s => s.name);
ok(sorted.join() === '酒店,午饭,景点,晚饭', '重排后：' + sorted.join(' → '));

// 没固定时间的地点跟着它前面那个固定时间点一起搬
list = [mk('酒店'), mk('晚饭', '18:30'), mk('夜景'), mk('午饭', '12:00'), mk('博物馆')];
sorted = Model.sortByFixedTime(list).map(s => s.name);
ok(sorted.join() === '酒店,午饭,博物馆,晚饭,夜景', '跟随关系保持：' + sorted.join(' → '));

// 本来就是对的，不该动
list = [mk('酒店'), mk('午饭', '12:00'), mk('景点'), mk('晚饭', '18:30')];
ok(Model.fixedOutOfOrder(list) === 0, '顺序正确时不报颠倒');
ok(Model.sortByFixedTime(list).map(s => s.name).join() === '酒店,午饭,景点,晚饭', '顺序正确时保持不变');

// 一个固定时间都没有 -> 原样返回
list = [mk('A'), mk('B'), mk('C')];
ok(Model.sortByFixedTime(list).map(s => s.name).join() === 'A,B,C', '没有固定时间时原样返回');
ok(Model.fixedOutOfOrder([]) === 0 && Model.sortByFixedTime([]).length === 0, '空列表不炸');

// 相同时间保持原有先后（稳定）
list = [mk('后加的', '12:00'), mk('先加的', '12:00')];
ok(Model.sortByFixedTime(list).map(s => s.name).join() === '后加的,先加的', '同一时间保持原有先后');

/* --- 9. Firebase 配置解析：控制台原样复制的各种形态都要吃下去 --- */
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

/* --- 9b. 导航链接 --- */
const nav = Util.navUrl({ lat: 37.7879, lng: -122.4103, name: '酒店' },
                        { lat: 37.8078, lng: -122.475, name: '金门大桥' }, 'DRIVING');
ok(nav.indexOf('https://www.google.com/maps/dir/?api=1') === 0, '用 Google 地图的通用链接（手机上会被 App 接管）');
ok(nav.indexOf('origin=37.7879%2C-122.4103') > 0, '起点用经纬度');
ok(nav.indexOf('travelmode=driving') > 0, '交通方式带过去');
ok(nav.indexOf('dir_action=navigate') > 0, '直接进入导航而不是只看路线');
const navByName = Util.navUrl({ name: 'Hotel A' }, { name: 'Pier 39' }, 'WALKING');
ok(navByName.indexOf('destination=Pier%2039') > 0, '没有坐标时退回用名字');
ok(navByName.indexOf('travelmode=walking') > 0, '步行模式');

/* --- 10. 地图服务的选择 --- */
const Maps = global.Maps;
ok(Maps.pick({}) === 'osm', '什么都没配时默认用 OpenStreetMap');
ok(Maps.pick({ mapsApiKey: 'AIza...' }) === 'google', '填了 Google Key 就用 Google');
ok(Maps.pick({ mapProvider: 'osm', mapsApiKey: 'AIza...' }) === 'osm', '显式指定优先于 Key');
ok(Maps.pick({ mapProvider: 'google' }) === 'google', '显式指定 Google');
ok(Maps.pick({ mapProvider: '乱填' }) === 'osm', '指定了不认识的服务时退回 OSM');
ok(Maps.keyFor('osm', { orsApiKey: 'ORS', mapsApiKey: 'G' }) === 'ORS', 'OSM 用 OpenRouteService 的 Key');
ok(Maps.keyFor('google', { orsApiKey: 'ORS', mapsApiKey: 'G' }) === 'G', 'Google 用自己的 Key');

/* --- 11. 路段缓存按地图服务分开 --- */
const S = global.Store;
const A = { lat: 37.78, lng: -122.41 }, B = { lat: 37.80, lng: -122.47 };
S.setProvider('osm');
S.putLeg(A, B, 'DRIVING', { minutes: 20, km: 8, path: [[1, 2]] });
ok(S.getLeg(A, B, 'DRIVING').minutes === 20, 'OSM 的缓存能读回来');
S.setProvider('google');
ok(S.getLeg(A, B, 'DRIVING') === null, '换成 Google 后读不到 OSM 的缓存（格式不同，不能混）');
S.putLeg(A, B, 'DRIVING', { minutes: 15, km: 8, encoded: 'abc' });
ok(S.getLeg(A, B, 'DRIVING').minutes === 15, 'Google 有自己的一份');
S.setProvider('osm');
ok(S.getLeg(A, B, 'DRIVING').minutes === 20, '切回来还是 OSM 那份');

/* --- 12. OpenRouteService 返回值解析 --- */
const OSM = global.MapsOSM;
const route = OSM.parseRoute({
  features: [{
    properties: { summary: { duration: 1382, distance: 9423 } },
    geometry: { coordinates: [[-122.41, 37.78], [-122.45, 37.80]] }
  }]
});
ok(route.minutes === 23, '秒换算成分钟：' + route.minutes);
ok(route.km === 9.4, '米换算成公里：' + route.km);
ok(route.estimated === false, '标记为真实数据');
ok(route.path[0][0] === 37.78 && route.path[0][1] === -122.41, 'GeoJSON 的经纬度顺序被翻转成 [纬度, 经度]');
ok(OSM.parseRoute({ features: [] }) === null, '空结果返回 null');
ok(OSM.parseRoute({}) === null, '坏数据返回 null');
ok(OSM.parseRoute({ features: [{ properties: {} }] }) === null, '缺 summary 返回 null');
// 极短的路程也要至少算 1 分钟，不能出现 0
ok(OSM.parseRoute({ features: [{ properties: { summary: { duration: 8, distance: 40 } },
  geometry: { coordinates: [] } }] }).minutes === 1, '不足一分钟按 1 分钟算');

/* --- 13. Photon 搜索结果转换 --- */
const place = OSM.toPlace({
  properties: { name: 'Tartine Bakery', osm_key: 'amenity', osm_value: 'cafe',
    housenumber: '600', street: 'Guerrero St', city: 'San Francisco', state: 'California', country: 'United States' },
  geometry: { coordinates: [-122.4241, 37.7614] }
});
ok(place.name === 'Tartine Bakery', '取到名字');
ok(place.lat === 37.7614 && place.lng === -122.4241, '经纬度翻转正确');
ok(place.address === '600 Guerrero St, San Francisco, California, United States', '地址拼接：' + place.address);
ok(place.types.indexOf('restaurant') >= 0, '咖啡馆识别成餐饮，会自动归到「吃饭」');

const hotel = OSM.toPlace({ properties: { name: 'Hotel Zeppelin', osm_key: 'tourism', osm_value: 'hotel' },
  geometry: { coordinates: [-122.41, 37.78] } });
ok(hotel.types.indexOf('lodging') >= 0, '酒店识别成住宿');
const park = OSM.toPlace({ properties: { name: 'Dolores Park', osm_key: 'leisure', osm_value: 'park' },
  geometry: { coordinates: [-122.42, 37.75] } });
ok(park.types.indexOf('park') >= 0, '公园识别成户外');

console.log(process.exitCode ? '有断言失败' : `全部 ${n} 条断言通过 ✅`);
