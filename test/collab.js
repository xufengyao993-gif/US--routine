const { stubTiles, stubWeather } = require('./helpers');
const { chromium } = require('playwright');
const fs = require('fs');
const MOCK = fs.readFileSync(require('path').join(__dirname, 'mock-firebase.mjs'), 'utf8');
const TRIP = 'testtrip0000000000000001';
const URL = 'http://127.0.0.1:8123/index.html?trip=' + TRIP;

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };
const waitFor = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await new Promise(r => setTimeout(r, 100)); }
  return -1;
};

(async () => {
  // 每次跑之前把这条测试行程清空，保证从干净状态开始
  await fetch('http://127.0.0.1:8124/', {
    method: 'POST', body: JSON.stringify({ op: 'set', path: 'trips/' + TRIP, value: null })
  }).catch(() => { console.error('连不上 test/fakedb.js，请先启动它'); process.exit(1); });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  async function client(name) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await stubTiles(ctx);
    await stubWeather(ctx);
    await ctx.route('https://www.gstatic.com/firebasejs/**', route =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
    await ctx.addInitScript(([nick]) => {
      localStorage.setItem('us-routine.config.v2', JSON.stringify({
        mapsApiKey: '', firebase: { apiKey: 'fake', databaseURL: 'http://fake', authDomain: '', projectId: '', appId: '' }
      }));
      localStorage.setItem('us-routine.my-name', nick);
    }, [name]);
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept());
    page.on('pageerror', e => { console.log('PAGEERROR[' + name + ']', e.message); fails++; });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    return page;
  }

  const A = await client('小明');
  ok((await A.locator('.stop').count()) === 10, 'A 载入示例行程（10 个点）');
  ok(!(await A.locator('.presence-hint').count()), 'A 进入协作模式（不是「仅本机」）');

  const B = await client('小红');
  const gotData = await waitFor(async () => (await B.locator('.stop').count()) === 10);
  ok(gotData >= 0, 'B 打开同一条链接，自动拿到 A 的行程（' + gotData + 'ms）');

  // A 改第 2 个点的停留时间 -> B 应该跟着变
  const beforeB = await B.locator('.stop-time').nth(1).textContent();
  await A.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  await A.locator('#f-stay').fill('30');
  await A.locator('#stopForm button[type=submit]').click();
  const t1 = await waitFor(async () => (await B.locator('.stop-time').nth(1).textContent()) !== beforeB);
  ok(t1 >= 0, 'A 改停留时间，B 端时间轴自动重算（' + t1 + 'ms）');
  ok((await B.locator('.stop-time').nth(1).textContent()) === (await A.locator('.stop-time').nth(1).textContent()),
    '两端算出的时间一致：' + (await B.locator('.stop-time').nth(1).textContent()));

  // B 删掉第 5 个点 -> A 跟着少一个，且 A 刚才的修改还在
  const nameToDelete = (await B.locator('.stop-name').nth(4).textContent());
  await B.locator('.stop').nth(4).locator('button', { hasText: '删除' }).click();
  const t2 = await waitFor(async () => (await A.locator('.stop').count()) === 9);
  ok(t2 >= 0, 'B 删点，A 端同步减少（' + t2 + 'ms）');
  ok(!(await A.locator('.stop-name').allTextContents()).includes(nameToDelete), '删掉的正是那个点：' + nameToDelete.trim());
  ok((await A.locator('.stop-time').nth(1).textContent()).includes('09:49'), 'A 之前的改动没有被覆盖');

  // 并发：A 改一个点、B 同时改另一个点，两边都要保留
  await Promise.all([
    (async () => {
      await A.locator('.stop').nth(2).locator('button', { hasText: '编辑' }).click();
      await A.locator('#f-name').fill('A改的点');
      await A.locator('#stopForm button[type=submit]').click();
    })(),
    (async () => {
      await B.locator('.stop').nth(6).locator('button', { hasText: '编辑' }).click();
      await B.locator('#f-notes').fill('B写的备注');
      await B.locator('#stopForm button[type=submit]').click();
    })()
  ]);
  const t3 = await waitFor(async () => {
    const names = await A.locator('.stop-name').allTextContents();
    const notes = await A.locator('.stop-notes').allTextContents();
    return names.some(n => n.includes('A改的点')) && notes.some(n => n.includes('B写的备注'));
  });
  ok(t3 >= 0, '同时改不同的点，两个人的改动都保留（' + t3 + 'ms）');

  // 顺序调整同步
  const orderA0 = await A.locator('.stop-name').allTextContents();
  await A.locator('.stop').nth(3).locator('button[title="上移"]').click();
  const t4 = await waitFor(async () => {
    const n = await B.locator('.stop-name').allTextContents();
    return n[2] === orderA0[3] && n[3] === orderA0[2];
  });
  ok(t4 >= 0, 'A 调顺序，B 端顺序跟着变（' + t4 + 'ms）');

  // 在线成员 + 谁在编辑
  const t5 = await waitFor(async () => (await A.locator('.presence .avatar').count()) >= 2);
  ok(t5 >= 0, 'A 看到 2 位在线成员');
  ok((await A.locator('.presence .avatar').first().getAttribute('title')).includes('小明'), '头像显示昵称');

  await B.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  const t6 = await waitFor(async () => (await A.locator('.badge-editing').count()) > 0);
  ok(t6 >= 0, 'B 打开某个点的编辑框，A 端显示「正在改」（' + t6 + 'ms）');
  ok((await A.locator('.badge-editing').first().textContent()).includes('小红'), '提示里是对方昵称');

  // 新增地点同步
  await B.locator('#stopCancel').click();
  await A.locator('#addStopBtn').click();
  await A.locator('#f-name').fill('新加的点');
  await A.locator('#f-lat').fill('37.79');
  await A.locator('#f-lng').fill('-122.40');
  await A.locator('#stopForm button[type=submit]').click();
  const t7 = await waitFor(async () => (await B.locator('.stop-name').allTextContents()).some(n => n.includes('新加的点')));
  ok(t7 >= 0, 'A 加点，B 端出现（' + t7 + 'ms）');

  // 行程标题同步
  await A.locator('#tripTitle').fill('改过的标题');
  await A.locator('#tripTitle').blur();
  const t8 = await waitFor(async () => (await B.locator('#tripTitle').inputValue()) === '改过的标题');
  ok(t8 >= 0, '标题同步（' + t8 + 'ms）');

  // 同一个地点：A 改名字，B 同时改停留时间，两个改动都要在
  const targetName = (await A.locator('.stop-name').nth(5).textContent()).replace(/^\S+\s/, '');
  await A.locator('.stop').nth(5).locator('button', { hasText: '编辑' }).click();
  await B.locator('.stop').nth(5).locator('button', { hasText: '编辑' }).click();   // 两人同时打开同一个点
  await A.locator('#f-name').fill('两人同时改的点');
  await B.locator('#f-stay').fill('123');
  await A.locator('#stopForm button[type=submit]').click();
  await B.waitForTimeout(400);                                                       // B 手里的表单已经是旧值了
  await B.locator('#stopForm button[type=submit]').click();
  const t9 = await waitFor(async () => {
    const names = await A.locator('.stop-name').allTextContents();
    return names.some(n => n.includes('两人同时改的点'));
  });
  ok(t9 >= 0, '同一个地点：A 改的名字保住了（B 保存时没拿旧值覆盖）');
  const t9b = await waitFor(async () => (await A.locator('.stop-stay').nth(5).textContent()).includes('2 小时 3 分'));
  ok(t9b >= 0, 'B 改的停留时间也生效（' + t9b + 'ms）：' + (await A.locator('.stop-stay').nth(5).textContent()));

  // 修改记录：两个人的改动都能看到，撤销也会同步
  await A.locator('#menuBtn').click();
  await A.locator('#historyBtn').click();
  await A.waitForTimeout(300);
  const who = await A.locator('.history-item .history-meta').allTextContents();
  ok(who.some(t => t.includes('小红')), 'A 的记录里看得到小红的改动');
  ok(who.some(t => t.includes('我')), 'A 的记录里也有自己的改动');

  const undoRow = A.locator('.history-item').filter({ hasText: '两人同时改的点' }).first();
  await undoRow.locator('button', { hasText: '撤销' }).click();
  const t10 = await waitFor(async () => {
    const names = await B.locator('.stop-name').allTextContents();
    return !names.some(n => n.includes('两人同时改的点')) && names.some(n => n.includes(targetName));
  });
  ok(t10 >= 0, 'A 点撤销，B 端跟着回退（' + t10 + 'ms）');
  await A.locator('#historyClose').click();

  await browser.close();
  console.log(fails ? '\n有 ' + fails + ' 项失败' : '\n协作全部通过 ✅');
  process.exit(fails ? 1 : 0);
})();
