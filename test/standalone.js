/* 从主屏幕图标启动（独立存储）时的恢复流程 */
const { chromium, devices } = require('playwright');
const { stubTiles, stubWeather } = require('./helpers');
const BASE = 'http://127.0.0.1:8123/index.html';

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  /* 先在「浏览器」里配好一份行程，拿到邀请链接 */
  const browserCtx = await browser.newContext(devices['iPhone 13']);
  await stubTiles(browserCtx);
  await stubWeather(browserCtx);
  await browserCtx.addInitScript(() => localStorage.setItem('us-routine.config.v2',
    JSON.stringify({ mapProvider: 'osm', orsApiKey: 'MY-ORS-KEY', mapsApiKey: '', firebase: {} })));
  const b1 = await browserCtx.newPage();
  await b1.goto(BASE + '?trip=standalone0000000000001', { waitUntil: 'domcontentloaded' });
  await b1.waitForTimeout(800);
  await b1.locator('#shareBtn').click();
  await b1.waitForTimeout(300);
  const inviteLink = await b1.locator('#shareLink').inputValue();
  ok(inviteLink.includes('trip=standalone0000000000001'), '邀请链接带着行程 ID');
  ok(inviteLink.includes('#cfg='), '本机配置时链接会把配置一起带上');
  const hint = await b1.locator('#shareInstallHint').textContent();
  ok(hint.includes('主屏幕'), '邀请弹窗里提醒了装桌面要用这条链接');
  await b1.locator('#shareClose').click();

  /* 模拟主屏幕图标：全新的存储 + standalone 显示模式 + 打开的是不带参数的地址 */
  const appCtx = await browser.newContext(Object.assign({}, devices['iPhone 13']));
  await stubTiles(appCtx);
  await stubWeather(appCtx);
  const app = await appCtx.newPage();
  await app.emulateMedia({ media: 'screen', reducedMotion: null, forcedColors: null, colorScheme: null });
  await app.addInitScript(() => {
    // 让页面以为自己是从主屏幕图标启动的
    Object.defineProperty(navigator, 'standalone', { get: () => true });
  });
  app.on('dialog', d => d.accept());
  await app.goto(BASE, { waitUntil: 'domcontentloaded' });
  await app.waitForTimeout(1200);

  ok(await app.locator('#restoreDialog').isVisible(), '图标首次打开时主动弹出「把行程接上」');
  const text = await app.locator('#restoreHint').textContent();
  ok(text.includes('自己的存储空间'), '说清楚了为什么读不到原来的行程');

  /* 粘贴邀请链接 */
  await app.locator('#f-link').fill(inviteLink);
  await app.locator('#restoreForm button[type=submit]').click();
  await app.waitForTimeout(1500);

  ok(app.url().includes('trip=standalone0000000000001'), '跳到了那份行程：' + app.url().split('?')[1]);
  const cfg = await app.evaluate(() => JSON.parse(localStorage.getItem('us-routine.config.v2') || '{}'));
  ok(cfg.orsApiKey === 'MY-ORS-KEY', '配置也跟着链接过来了，不用重新填 Key');
  ok(await app.locator('#restoreDialog').isVisible() === false, '弹窗已关闭');

  /* 再打开一次（模拟以后每次点图标）：不该再问 */
  const again = await appCtx.newPage();
  await again.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  await again.goto(BASE, { waitUntil: 'domcontentloaded' });
  await again.waitForTimeout(1200);
  ok(await again.locator('#restoreDialog').isVisible() === false, '之后再从图标打开不再询问');
  ok(again.url().includes('trip=standalone0000000000001'), '直接落到同一份行程：' + again.url().split('?')[1]);

  /* 手动入口：菜单里随时能换行程 */
  await again.locator('#menuBtn').click();
  await again.locator('#openLinkBtn').click();
  await again.waitForTimeout(300);
  ok(await again.locator('#restoreDialog').isVisible(), '菜单里的「🔗 打开行程链接」可用');
  ok((await again.locator('#restoreTitle').textContent()) === '打开行程链接', '手动打开时用的是普通标题');
  await again.locator('#f-link').fill('乱七八糟的一段字');
  await again.locator('#restoreForm button[type=submit]').click();
  await again.waitForTimeout(300);
  ok(await again.locator('#restoreDialog').isVisible(), '粘了无效内容时不关弹窗，给出提示');
  // 只给行程 ID 也认
  await again.locator('#f-link').fill('standalone0000000000002');
  await again.locator('#restoreForm button[type=submit]').click();
  await again.waitForTimeout(1200);
  ok(again.url().includes('trip=standalone0000000000002'), '只粘一串行程 ID 也能打开');

  /* 普通浏览器里（非图标）不该弹这个 */
  const plainCtx = await browser.newContext(devices['iPhone 13']);
  await stubTiles(plainCtx);
  await stubWeather(plainCtx);
  const plain = await plainCtx.newPage();
  await plain.goto(BASE, { waitUntil: 'domcontentloaded' });
  await plain.waitForTimeout(1200);
  ok(await plain.locator('#restoreDialog').isVisible() === false, '在普通浏览器里首次打开不打扰');

  await browser.close();
  console.log(fails ? '\n有 ' + fails + ' 项失败' : '\n主屏幕图标恢复流程全部通过 ✅');
  process.exit(fails ? 1 : 0);
})();
