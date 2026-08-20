/* 营业时间校验 + 顺序建议（只提示，改不改用户说了算） */
const { chromium } = require('playwright');
const { stubTiles, stubRoutes, stubWeather } = require('./helpers');
const PAGE = 'http://127.0.0.1:8123/index.html';

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await stubTiles(ctx);
  await stubWeather(ctx);
  await stubRoutes(ctx);
  // Overpass：假装这个地点每天 10:00-17:00
  let overpassCalls = 0;
  await ctx.route('https://overpass-api.de/**', r => {
    overpassCalls++;
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      elements: [{ type: 'node', id: 1, tags: { opening_hours: 'Mo-Su 10:00-17:00' } }] }) });
  });
  await ctx.route('https://photon.komoot.io/**', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      features: [{
        properties: { name: 'Test Museum', osm_key: 'tourism', osm_value: 'museum',
          osm_type: 'N', osm_id: 1, city: 'San Francisco', country: 'United States' },
        geometry: { coordinates: [-122.45, 37.79] }
      }] }) }));
  await ctx.addInitScript(() => localStorage.setItem('us-routine.config.v2',
    JSON.stringify({ mapProvider: 'osm', orsApiKey: 'K', firebase: {} })));

  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
  await p.goto(PAGE + '?trip=hours000000000000000001', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);

  /* ---------- 营业时间：手填 ---------- */
  // 示例第一天是 2026-09-12（周六），第 2 个点 09:19-10:54
  await p.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  await p.waitForTimeout(300);
  await p.locator('#f-hours').fill('Mo-Fr 09:00-17:00');
  await p.waitForTimeout(200);
  ok((await p.locator('#hours-status').textContent()).includes('能识别'), '边填边告诉你能不能识别');
  await p.locator('#stopForm button[type=submit]').click();
  await p.waitForTimeout(600);

  const badge = await p.locator('.stop').nth(1).locator('.badge-late').textContent();
  ok(badge.includes('周六不营业'), '周六去只开工作日的地方 → 标红：' + badge);
  ok((await p.locator('.warn-bar').filter({ hasText: '关着门' }).count()) === 1, '当天概览里汇总提醒');

  // 改成周末也开，但 10:00 才开门（我们 09:19 就到）
  await p.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  await p.locator('#f-hours').fill('Mo-Su 10:00-17:00');
  await p.locator('#stopForm button[type=submit]').click();
  await p.waitForTimeout(600);
  const early = await p.locator('.stop').nth(1).locator('.badge-late').textContent();
  ok(early.includes('10:00'), '到早了会说几点才开：' + early);

  // 改成 09:00 开门 → 应该显示营业中
  await p.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  await p.locator('#f-hours').fill('Mo-Su 09:00-18:00');
  await p.locator('#stopForm button[type=submit]').click();
  await p.waitForTimeout(600);
  ok((await p.locator('.stop').nth(1).locator('.badge-fixed').first().textContent()).includes('营业中'), '时间对得上时显示营业中');
  ok((await p.locator('.warn-bar').filter({ hasText: '关着门' }).count()) === 0, '没问题时不再提醒');

  // 看不懂的写法不报警
  await p.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  await p.locator('#f-hours').fill('sunrise-sunset');
  await p.waitForTimeout(200);
  ok((await p.locator('#hours-status').textContent()).includes('看不懂'), '看不懂的写法会明说');
  await p.locator('#stopForm button[type=submit]').click();
  await p.waitForTimeout(600);
  ok((await p.locator('.stop').nth(1).locator('.badge-late').count()) === 0, '看不懂时不乱报警');

  /* ---------- 营业时间：从地图数据自动填 ---------- */
  await p.locator('#addStopBtn').click();
  await p.waitForTimeout(300);
  await p.locator('#f-search').fill('museum');
  await p.waitForTimeout(700);
  await p.locator('.osm-suggest-item').first().click();
  await p.waitForTimeout(1500);
  ok(overpassCalls > 0, '选中地点后去查了营业时间');
  ok((await p.locator('#f-hours').inputValue()) === 'Mo-Su 10:00-17:00', '自动填上了：' + await p.locator('#f-hours').inputValue());
  await p.locator('#stopCancel').click();

  /* ---------- 顺序建议 ---------- */
  // 造一个明显绕路的一天：在末尾插一个远点，再插一个近点
  await p.locator('.daytab-add').click();
  await p.waitForTimeout(500);
  const add = async (name, lat, lng) => {
    await p.locator('#addStopBtn').click();
    await p.waitForTimeout(250);
    await p.locator('#f-name').fill(name);
    await p.locator('#f-lat').fill(String(lat));
    await p.locator('#f-lng').fill(String(lng));
    await p.locator('#f-stay').fill('30');
    await p.locator('#stopForm button[type=submit]').click();
    await p.waitForTimeout(400);
  };
  await add('酒店', 37.7879, -122.4103);
  await add('金门大桥', 37.8078, -122.4750);
  await add('渡轮大厦', 37.7955, -122.3937);
  await add('艺术宫', 37.8029, -122.4484);
  await add('回酒店', 37.7879, -122.4103);
  await p.waitForTimeout(1200);

  const hintBar = p.locator('.warn-bar-action').filter({ hasText: '少绕' });
  ok(await hintBar.count() === 1, '绕路时出现提示条');
  const hintText = await hintBar.textContent();
  ok(hintText.includes('估算'), '提示里说清楚是估算：' + hintText.trim().slice(0, 40));

  await hintBar.locator('button').click();
  await p.waitForTimeout(400);
  ok(await p.locator('#reorderDialog').isVisible(), '打开对照弹窗');
  const now = await p.locator('#reorderNow li').allTextContents();
  const next = await p.locator('#reorderNext li').allTextContents();
  ok(now.length === 5 && next.length === 5, '两列都列出全部 5 个地点');
  ok(now[0] === next[0] && now[4] === next[4], '第一个和最后一个没动');
  ok(now.join() !== next.join(), '建议的顺序确实不一样：' + next.join('→'));

  // 先不改 —— 顺序必须原样
  await p.locator('#reorderClose').click();
  await p.waitForTimeout(300);
  const names = async () => (await p.locator('.stop-name').allTextContents()).map(s => s.replace(/^\S+\s/, ''));
  ok((await names()).join() === now.join(), '点「先不改」不动任何东西');

  // 按建议排
  await hintBar.locator('button').click();
  await p.waitForTimeout(300);
  await p.locator('#reorderApply').click();
  await p.waitForTimeout(1200);
  ok((await names()).join() === next.join(), '点「按这个顺序排」才真的改：' + (await names()).join('→'));
  ok(await p.locator('.warn-bar-action').filter({ hasText: '少绕' }).count() === 0, '排完之后提示消失');

  // 可撤销
  await p.locator('#undoBtn').click();
  await p.waitForTimeout(800);
  ok((await names()).join() === now.join(), '撤销能回到原来的顺序');

  // 「这天不用再提」
  await p.locator('.warn-bar-action').filter({ hasText: '少绕' }).locator('button').click();
  await p.waitForTimeout(300);
  await p.locator('#reorderNever').click();
  await p.waitForTimeout(500);
  ok(await p.locator('.warn-bar-action').filter({ hasText: '少绕' }).count() === 0, '选了「不用再提」后提示消失');
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
  ok(await p.locator('.warn-bar-action').filter({ hasText: '少绕' }).count() === 0, '刷新后也不再提');

  /* ---------- 菜单里主动查顺序 ---------- */
  // 回到示例第一天（本来就排得挺顺，不会自动提示）
  await p.locator('.daytab').nth(0).click();
  await p.waitForTimeout(600);
  ok(await p.locator('.warn-bar-action').filter({ hasText: '少绕' }).count() === 0, '排得顺的一天不会自动弹提示');

  await p.locator('#menuBtn').click();
  await p.locator('#reorderBtn').click();
  await p.waitForTimeout(500);
  const verdict = await p.locator('#toast').textContent();
  ok(verdict.includes('挺顺的'), '主动查会明确回答「已经挺顺的了」：' + verdict);
  ok(await p.locator('#reorderDialog').isVisible() === false, '没得优化时不开弹窗');

  // 绕路那天主动查 -> 应该开弹窗
  await p.locator('.daytab').nth(3).click();
  await p.waitForTimeout(600);
  await p.locator('#menuBtn').click();
  await p.locator('#reorderBtn').click();
  await p.waitForTimeout(500);
  ok(await p.locator('#reorderDialog').isVisible(), '绕路那天主动查会打开对照弹窗');
  await p.locator('#reorderClose').click();

  await browser.close();
  console.log(fails ? '\n有 ' + fails + ' 项失败' : '\n营业时间与顺序建议全部通过 ✅');
  process.exit(fails ? 1 : 0);
})();
