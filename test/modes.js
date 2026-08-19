/* 交通方式：Uber / 租车 / 旅行团 三选一，耗时一致；老数据仍然认得 */
const { chromium } = require('playwright');
const { stubTiles, stubRoutes } = require('./helpers');
const PAGE = 'http://127.0.0.1:8123/index.html';

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await stubTiles(ctx);
  let routeCalls = 0;
  await ctx.route('https://api.openrouteservice.org/**', r => {
    routeCalls++;
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      features: [{ properties: { summary: { duration: 1500, distance: 9000 } },
        geometry: { coordinates: [[-122.41, 37.78], [-122.45, 37.80]] } }] }) });
  });
  await ctx.addInitScript(() => localStorage.setItem('us-routine.config.v2',
    JSON.stringify({ mapProvider: 'osm', orsApiKey: 'K', firebase: {} })));

  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
  await p.goto(PAGE + '?trip=modes0000000000000000001', { waitUntil: 'domcontentloaded' });

  // 首次进来会把整天的路段挨个查一遍（有限速），等它彻底停下来再断言，
  // 否则拿到的还是估算值、请求数也还在涨
  const settle = async () => {
    let last = -1;
    while (last !== routeCalls) {
      last = routeCalls;
      await p.waitForTimeout(1200);
    }
    await p.waitForTimeout(300);
  };
  await settle();

  /* --- 选项 --- */
  await p.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  await p.waitForTimeout(300);
  const options = await p.locator('#f-mode option').allTextContents();
  ok(options.length === 6, '一共 6 个选项：' + options.join(' / '));
  ok(options.some(o => o.includes('Uber')) && options.some(o => o.includes('租车')) && options.some(o => o.includes('旅行团')),
    'Uber / 租车 / 旅行团 都在');
  ok(!options.some(o => o.includes('开车')), '「开车」已经去掉');

  /* --- 老数据（示例行程里存的是新值，这里手工塞一条老的 DRIVING）--- */
  ok((await p.locator('#f-mode').inputValue()) === 'RENTAL', '示例数据里的车程默认落在「租车」');
  await p.locator('#stopCancel').click();

  /* --- 三种车耗时一致，而且只查一次路线 --- */
  const legText = async () => (await p.locator('.leg-head').first().textContent()).trim();
  const before = await legText();
  ok(before.includes('租车') && before.includes('25 分钟'), '当前是租车 25 分钟：' + before);

  const callsBefore = routeCalls;
  await p.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  await p.locator('#f-mode').selectOption('UBER');
  await p.locator('#stopForm button[type=submit]').click();
  await settle();
  const afterUber = await legText();
  ok(afterUber.includes('Uber') && afterUber.includes('25 分钟'), '换成 Uber 后耗时不变：' + afterUber);
  ok(routeCalls === callsBefore, '没有重新查路线（三种车共用缓存），请求数仍是 ' + routeCalls);

  await p.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  await p.locator('#f-mode').selectOption('TOUR');
  await p.locator('#stopForm button[type=submit]').click();
  await settle();
  const afterTour = await legText();
  ok(afterTour.includes('旅行团') && afterTour.includes('25 分钟'), '换成旅行团也一样：' + afterTour);
  ok(routeCalls === callsBefore, '依然没有多查');

  /* --- 导航链接 --- */
  const href = await p.locator('.leg').first().locator('a').getAttribute('href');
  ok(href.includes('travelmode=driving'), '旅行团的导航链接仍然用 driving：' + href.split('&').slice(-2).join('&'));

  /* --- 「换交通方式」按钮的循环顺序 --- */
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await p.locator('.leg').first().locator('button', { hasText: '换交通方式' }).click();
    await p.waitForTimeout(500);
    seen.push((await legText()).split(/\s+/)[1]);
  }
  ok(seen.length === 6 && new Set(seen).size === 6, '循环一圈覆盖 6 种：' + seen.join(' → '));

  /* --- 老数据兼容：直接往存储里塞一条 DRIVING --- */
  await p.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith('us-routine.trip.v2:'));
    const trip = JSON.parse(localStorage.getItem(key));
    const day = Object.values(trip.days).sort((a, b) => a.order - b.order)[0];
    const stop = Object.values(day.stops).sort((a, b) => a.order - b.order)[1];
    stop.arriveMode = 'DRIVING';                 // 老版本写下的值
    localStorage.setItem(key, JSON.stringify(trip));
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await settle();
  const legacy = await legText();
  ok(legacy.includes('租车') && legacy.includes('25 分钟'), '老的 DRIVING 显示成「租车」，耗时照旧：' + legacy);
  await p.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  await p.waitForTimeout(300);
  ok((await p.locator('#f-mode').inputValue()) === 'RENTAL', '打开编辑框时选中的是「租车」，不会变成空白');

  await browser.close();
  console.log(fails ? '\n有 ' + fails + ' 项失败' : '\n交通方式全部通过 ✅');
  process.exit(fails ? 1 : 0);
})();
