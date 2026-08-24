/*
 * 协作服务断了之后能不能自己回来。
 *
 * 场景取自真实事故：Firebase 的 API Key 被 Google 暂停了几个小时，
 * 恢复之后应用还挂着旧的失败状态，只能杀进程重开。现在应该做到：
 *   1. 连不上时状态条给出「立即重试」按钮和下次自动重试的时间
 *   2. 服务恢复后点一下按钮就能连上，不用刷新页面
 *   3. 页面从后台切回前台时自己重试一次
 */
const { stubTiles, stubWeather } = require('./helpers');
const { chromium } = require('playwright');
const fs = require('fs');
const OK_MOCK = fs.readFileSync(require('path').join(__dirname, 'mock-firebase.mjs'), 'utf8');
// 浏览器会缓存 ES 模块，重连时不会重新下载 SDK（真实环境也是这样：坏的是 Key，不是 SDK）。
// 所以用一个运行时开关来模拟「服务端恢复了」。
const MOCK = OK_MOCK.replace(
  /export function signInAnonymously\(\)[^\n]*\n/,
  "export function signInAnonymously() {\n" +
  "  if (globalThis.__fbHealthy) return Promise.resolve({ user: { uid: 'u1' } });\n" +
  "  return Promise.reject(new Error(\"Firebase: Error (auth/permission-denied: consumer 'api-key:fake' has been suspended.)\"));\n" +
  "}\n"
);
const TRIP = 'testtrip0000000000000042';
const PAGE = 'http://127.0.0.1:8123/index.html?trip=' + TRIP;

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };
const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); }
  return false;
};

(async () => {
  await fetch('http://127.0.0.1:8124/', {
    method: 'POST', body: JSON.stringify({ op: 'set', path: 'trips/' + TRIP, value: null })
  }).catch(() => { console.error('连不上 test/fakedb.js，请先启动它'); process.exit(1); });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await stubTiles(ctx);
  await stubWeather(ctx);

  // 一开始登录会被「Key 已停用」挡回来
  await ctx.route('https://www.gstatic.com/firebasejs/**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));

  await ctx.addInitScript(() => {
    localStorage.setItem('us-routine.config.v2', JSON.stringify({
      mapsApiKey: '', firebase: { apiKey: 'fake', databaseURL: 'http://fake', authDomain: '', projectId: '', appId: '' }
    }));
    localStorage.setItem('us-routine.my-name', '小明');
  });

  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });

  const bar = page.locator('#syncBar');
  const btn = page.locator('.sync-bar-btn');

  ok(await waitFor(async () => (await bar.textContent() || '').includes('连接失败')), '连不上时状态条说明原因');
  const text = await bar.textContent();
  ok(/suspended/i.test(text), '把服务端给的原话带出来：' + text.slice(0, 60) + '…');
  ok(await btn.isVisible(), '给出「立即重试」按钮');
  ok(/秒后自动重试|分钟后自动重试/.test(text), '同时说明多久之后会自己再试一次');

  // 行程本身照常可用，本地不受影响
  ok((await page.locator('.stop').count()) > 0, '连不上也照常显示行程');

  // 服务端恢复了：不刷新页面，点一下按钮就该连上
  await page.evaluate(() => { globalThis.__fbHealthy = true; });
  await btn.click();
  ok(await waitFor(async () => await bar.isHidden()), '点「立即重试」后连上，黄条自己消失');

  // 连上之后本地的行程要能推上去
  const pushed = await waitFor(async () => {
    const r = await fetch('http://127.0.0.1:8124/', {
      method: 'POST', body: JSON.stringify({ op: 'get', path: 'trips/' + TRIP + '/data' })
    }).then(r => r.json());
    return r.value && r.value.days;
  });
  ok(pushed, '重连之后本地行程同步到了服务端');

  await browser.close();
  console.log(fails ? '\n有 ' + fails + ' 项没通过 ❌' : '\n断线重连全部通过 ✅');
  process.exit(fails ? 1 : 0);
})();
