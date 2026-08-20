/* 天气：当天概览的天气条 + 地点卡片上按时段的角标 */
const { chromium } = require('playwright');
const { stubTiles, stubRoutes, stubWeather } = require('./helpers');
const PAGE = 'http://127.0.0.1:8123/index.html';

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };
const waitFor = async (p, fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await p.waitForTimeout(150); }
  return false;
};

// 把「今天」固定住，否则示例行程的日期一会儿在预报范围内、一会儿又不在
const FIXED_NOW = new Date('2026-09-08T09:00:00Z').getTime();
const freezeClock = ctx => ctx.addInitScript(now => {
  const R = Date;
  function F(...a) { return a.length ? new R(...a) : new R(now); }
  F.prototype = R.prototype; F.now = () => now; F.parse = R.parse; F.UTC = R.UTC;
  window.Date = F;
}, FIXED_NOW);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  /* ---------- 预报（示例第一天 2026-09-12，距离固定的今天 4 天） ---------- */
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await stubTiles(ctx); await stubRoutes(ctx);
  let forecastCalls = 0, archiveCalls = 0;
  // 用请求事件计数：ctx.route 是后注册的先匹配，计数器写成路由会把桩挡掉
  ctx.on('request', req => {
    if (req.url().startsWith('https://api.open-meteo.com/')) forecastCalls++;
    if (req.url().startsWith('https://archive-api.open-meteo.com/')) archiveCalls++;
  });
  await stubWeather(ctx, { min: 15, max: 24, precip: 40, code: 2 });
  await freezeClock(ctx);
  await ctx.addInitScript(() => localStorage.setItem('us-routine.config.v2',
    JSON.stringify({ mapProvider: 'osm', orsApiKey: 'K', firebase: {} })));

  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
  await p.goto(PAGE + '?trip=weather00000000000000001', { waitUntil: 'domcontentloaded' });

  ok(await waitFor(p, async () => (await p.locator('.weather').count()) > 0), '当天概览上方出现天气条');
  const strip = await p.locator('.weather').first().textContent();
  ok(strip.includes('15–24°C'), '显示当天气温区间：' + strip.trim());
  ok(strip.includes('多云'), '显示天气状况');
  ok(strip.includes('降水 40%'), '显示降水概率');
  ok(strip.includes('14:00–17:00') && strip.includes('有雨'), '指出行程时段里可能下雨的区间：' + strip.trim());
  ok(forecastCalls > 0 && archiveCalls === 0, '4 天后走预报接口，没去查历史');

  /* ---------- 地点卡片按各自时段取天气 ---------- */
  ok(await waitFor(p, async () => (await p.locator('.badge-weather').count()) > 0), '地点卡片上有天气角标');
  const badges = await p.locator('.badge-weather').allTextContents();
  ok(badges.length >= 5, '多个地点都有：' + badges.length + ' 个');
  // 示例第一天：第 2 站 09:19-10:54（上午，不下雨），有个点在下午
  ok(!badges[1].includes('%'), '上午的地点不标降水：' + badges[1]);
  const wet = await p.locator('.badge-weather.is-wet').count();
  ok(wet > 0, '下午到访的地点标出高降水概率（' + wet + ' 个）');
  const wetText = await p.locator('.badge-weather.is-wet').first().textContent();
  ok(wetText.includes('70%'), '角标带上降水概率：' + wetText);

  /* ---------- 只查一次，重绘不会反复发请求 ---------- */
  const before = forecastCalls;
  await p.locator('.stop').nth(1).click();
  await p.locator('.stop').nth(2).click();
  await p.waitForTimeout(800);
  ok(forecastCalls === before, '点来点去不会重复请求天气（仍是 ' + forecastCalls + ' 次）');

  /* ---------- 切到别的日期会另外查一次 ---------- */
  await p.locator('.daytab').nth(1).click();
  ok(await waitFor(p, async () => forecastCalls > before), '换一天会去查那天的天气');

  /* ---------- 太远的日期 -> 往年同期，且说明不是预报 ---------- */
  await p.locator('.daytab').nth(0).click();
  await p.waitForTimeout(400);
  await p.locator('.day-inputs input[type=date]').fill('2027-06-15');   // 远远超出预报范围
  await p.locator('.day-inputs input[type=date]').blur();
  ok(await waitFor(p, async () => (await p.locator('.weather-normals').count()) > 0), '超出预报范围时改用往年同期');
  const normals = await p.locator('.weather-normals').textContent();
  ok(normals.includes('不是预报'), '明确说明这不是预报：' + normals.trim());
  ok(normals.includes('14–22°C'), '给出往年平均气温：' + normals.trim());
  ok(archiveCalls > 0, '确实查了历史接口');
  ok((await p.locator('.badge-weather').count()) === 0, '往年同期没有逐小时数据，不给地点标角标');

  /* ---------- 查不到天气时安静降级 ---------- */
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await stubTiles(ctx2); await stubRoutes(ctx2);
  await ctx2.route('https://api.open-meteo.com/**', r => r.fulfill({ status: 500, body: 'boom' }));
  await ctx2.route('https://archive-api.open-meteo.com/**', r => r.fulfill({ status: 500, body: 'boom' }));
  const p2 = await ctx2.newPage();
  p2.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
  await p2.goto(PAGE + '?trip=weatherfail000000000001', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(2500);
  ok((await p2.locator('.stop').count()) > 0, '天气服务挂了，行程照常显示');
  const quiet = await p2.locator('.weather-quiet').count();
  ok(quiet === 1, '只留一行「查不到」的淡提示，不打扰');
  await ctx2.close();

  await browser.close();
  console.log(fails ? '\n有 ' + fails + ' 项失败' : '\n天气全部通过 ✅');
  process.exit(fails ? 1 : 0);
})();
