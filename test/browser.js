const { stubTiles } = require('./helpers');
const { chromium, devices } = require('playwright');
const SP = process.env.SP || require('os').tmpdir();
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const errors = [];
  const watch = p => {
    p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  };

  /* ---------- 手机 ---------- */
  const iphone = await browser.newContext(devices['iPhone 13']);
  await stubTiles(iphone);
  const m = await iphone.newPage(); watch(m);
  // isMobile 模式下 Playwright 对 fixed 元素的可点击性判定有误报，用真实坐标点
  const tap = async (loc) => {
    await loc.scrollIntoViewIfNeeded();
    const r = await loc.boundingBox();
    await m.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
    await m.waitForTimeout(250);
  };
  await m.goto('http://127.0.0.1:8123/index.html', { waitUntil: 'networkidle' });
  await m.waitForTimeout(600);

  console.log('URL 自动带上行程 ID:', m.url().includes('?trip=') ? '✅ ' + m.url().split('?')[1].slice(0,20)+'…' : '❌');
  console.log('手机默认显示行程栏, 地图隐藏:',
    await m.locator('.panel').isVisible(), await m.locator('.mapwrap').isVisible());
  console.log('底部标签可见:', await m.locator('.mobile-tabs').isVisible());
  console.log('地点数:', await m.locator('.stop').count(), '路段数:', await m.locator('.leg').count());

  await tap(m.locator('.mobile-tab[data-view="map"]'));
  console.log('切到地图后:', 'panel=' + await m.locator('.panel').isVisible(), 'map=' + await m.locator('.mapwrap').isVisible());
  await m.screenshot({ path: SP + '/mobile-map.png' });
  await tap(m.locator('.mobile-tab[data-view="list"]'));
  await m.screenshot({ path: SP + '/mobile.png' });

  // Service Worker
  const swState = await m.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? (reg.active ? 'active' : reg.installing ? 'installing' : 'waiting') : 'none';
  });
  console.log('Service Worker:', swState);
  const manifest = await m.evaluate(() => fetch('manifest.webmanifest').then(r => r.json()).then(j => j.name + ' / icons=' + j.icons.length));
  console.log('Manifest:', manifest);

  // 邀请弹窗
  await tap(m.locator('#shareBtn'));
  console.log('邀请链接:', (await m.locator('#shareLink').inputValue()).replace('http://127.0.0.1:8123',''));
  console.log('邀请提示:', (await m.locator('#shareHint').textContent()).slice(0, 30) + '…');
  await m.screenshot({ path: SP + '/mobile-share.png' });
  await tap(m.locator('#shareClose'));

  // 菜单 + 设置
  await tap(m.locator('#menuBtn'));
  console.log('菜单项:', (await m.locator('.menu-item').allTextContents()).join(' / '));
  await tap(m.locator('#settingsBtn'));
  console.log('设置弹窗:', await m.locator('#settingsDialog').isVisible(), '| 配置来源:', await m.locator('#configSource').textContent());
  await tap(m.locator('#settingsCancel'));

  // 编辑一个点，确认时间重算
  const before = await m.locator('.stop-time').nth(1).textContent();
  await tap(m.locator('.stop').nth(1).locator('button', { hasText: '编辑' }));
  await m.locator('#f-stay').fill('30');
  await tap(m.locator('#stopForm button[type=submit]'));
  console.log('改停留 95->30 分钟:', before, '=>', await m.locator('.stop-time').nth(1).textContent());

  // 移动顺序
  const names0 = await m.locator('.stop-name').allTextContents();
  await tap(m.locator('.stop').nth(2).locator('button[title="上移"]'));
  const names1 = await m.locator('.stop-name').allTextContents();
  console.log('上移生效:', names0[1] === names1[2] && names0[2] === names1[1] ? '✅' : '❌ ' + names1.slice(0,3));

  // 刷新后数据仍在（本地缓存 + 行程 ID）
  await m.reload({ waitUntil: 'networkidle' });
  await m.waitForTimeout(500);
  const names2 = await m.locator('.stop-name').allTextContents();
  console.log('刷新后顺序保持:', names1.join()===names2.join() ? '✅' : '❌');

  /* ---------- 桌面 ---------- */
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await stubTiles(desk);
  const d = await desk.newPage(); watch(d);
  await d.goto('http://127.0.0.1:8123/index.html', { waitUntil: 'networkidle' });
  await d.waitForTimeout(500);
  console.log('桌面两栏同时显示:', await d.locator('.panel').isVisible() && await d.locator('.mapwrap').isVisible());
  console.log('桌面底部标签隐藏:', !(await d.locator('.mobile-tabs').isVisible()));
  console.log('本地模式标识:', await d.locator('.presence-hint').textContent());
  await d.screenshot({ path: SP + '/desktop.png' });

  await browser.close();
  console.log(errors.length ? '\nERRORS:\n' + errors.join('\n') : '\n无 JS 报错 ✅');
})();
