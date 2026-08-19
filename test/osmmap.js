/* OpenStreetMap 地图：加载、打点连线、真实路程、地点搜索 */
const { chromium, devices } = require('playwright');
const { stubTiles, stubRoutes, stubSearch } = require('./helpers');
const URL = 'http://127.0.0.1:8123/index.html?trip=osmtest00000000000000001';

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };
const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 120)); }
  return false;
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await stubTiles(ctx);
  await stubRoutes(ctx, { minutes: 23, km: 9.4 });
  await stubSearch(ctx);
  // 假装已经填了 OpenRouteService Key
  await ctx.addInitScript(() => {
    localStorage.setItem('us-routine.config.v2', JSON.stringify({
      mapProvider: 'osm', orsApiKey: 'TEST-ORS-KEY', mapsApiKey: '', firebase: {}
    }));
  });

  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  p.on('dialog', d => d.accept());

  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);

  /* --- 地图本体 --- */
  ok(await p.locator('.leaflet-container').count() === 1, '地图加载出来了（不需要任何 Key）');
  ok(await p.locator('#mapNotice').isVisible() === false, '没有再提示去填 Google Key');
  const attribution = await p.locator('.leaflet-control-attribution').textContent();
  ok(attribution.includes('OpenStreetMap'), '标注了 OpenStreetMap 版权：' + attribution.slice(0, 40) + '…');

  /* --- 打点 --- */
  const stops = await p.locator('.stop').count();
  await waitFor(async () => (await p.locator('.osm-pin').count()) === stops);
  const pins = await p.locator('.osm-pin').count();
  ok(pins === stops, '每个地点一个图钉：' + pins + ' 个（地点 ' + stops + ' 个）');
  ok((await p.locator('.osm-pin-body').first().textContent()).trim() === '1', '图钉上有顺序编号');

  /* --- 连线 --- */
  const paths = await p.locator('.leaflet-overlay-pane path').count();
  ok(paths === stops - 1, '相邻地点之间连线：' + paths + ' 条');

  /* --- 真实路程耗时 --- */
  const gotReal = await waitFor(async () =>
    (await p.locator('.leg-dur').first().textContent()).includes('23 分钟'));
  ok(gotReal, '拿到 OpenRouteService 的真实耗时：' + await p.locator('.leg-dur').first().textContent());
  ok(await p.locator('.leg').first().locator('.badge-muted').count() === 0, '不再标「估算」');
  ok((await p.locator('.leg-km').first().textContent()).includes('9.4'), '距离也是真实的：' + await p.locator('.leg-km').first().textContent());

  /* --- 公交没有真实数据，要老实标估算 --- */
  await p.locator('.leg').first().locator('button', { hasText: '换交通方式' }).click();
  await p.waitForTimeout(900);
  const legHead = await p.locator('.leg-head').first().textContent();
  ok(legHead.includes('公共交通') && legHead.includes('估算'), '公交段如实标注估算：' + legHead.trim());

  /* --- 地点搜索 --- */
  await p.locator('#addStopBtn').click();
  await p.waitForTimeout(300);
  await p.locator('#f-search').fill('golden gate');
  await p.waitForTimeout(700);
  const items = await p.locator('.osm-suggest-item').count();
  ok(items === 2, '搜索给出候选：' + items + ' 条');
  ok((await p.locator('.osm-suggest-name').first().textContent()) === 'Golden Gate Bridge', '第一条是 Golden Gate Bridge');

  await p.locator('.osm-suggest-item').first().click();
  await p.waitForTimeout(300);
  ok((await p.locator('#f-name').inputValue()) === 'Golden Gate Bridge', '选中后回填名称');
  ok((await p.locator('#f-lat').inputValue()).startsWith('37.81'), '回填纬度：' + await p.locator('#f-lat').inputValue());
  ok((await p.locator('#f-lng').inputValue()).startsWith('-122.47'), '回填经度：' + await p.locator('#f-lng').inputValue());
  ok((await p.locator('#f-category').inputValue()) === 'attraction', '类型自动识别成景点');

  // 餐饮要自动归到「吃饭」
  await p.locator('#f-search').fill('tartine');
  await p.waitForTimeout(700);
  await p.locator('.osm-suggest-item').nth(1).click();
  await p.waitForTimeout(300);
  ok((await p.locator('#f-category').inputValue()) === 'food', '咖啡馆自动归到「吃饭」');

  await p.locator('#f-stay').fill('40');
  await p.locator('#stopForm button[type=submit]').click();
  const grew = await waitFor(async () => (await p.locator('.osm-pin').count()) === pins + 1);
  ok(grew, '新加的地点也出现在地图上');

  /* --- 切到 Google 需要 Key，切回来还能用 --- */
  await p.locator('#menuBtn').click();
  await p.locator('#settingsBtn').click();
  await p.waitForTimeout(300);
  ok(await p.locator('#field-ors').isVisible(), '选 OSM 时显示 OpenRouteService Key 输入框');
  ok(await p.locator('#field-gmaps').isVisible() === false, '同时隐藏 Google Key 输入框');
  await p.locator('#f-provider').selectOption('google');
  await p.waitForTimeout(200);
  ok(await p.locator('#field-gmaps').isVisible(), '切到 Google 后显示 Google Key 输入框');
  ok(await p.locator('#field-ors').isVisible() === false, '同时隐藏 ORS 输入框');
  await p.locator('#settingsCancel').click();

  await browser.close();
  const real = errors.filter(e => !/favicon|tile\.openstreetmap/.test(e));
  if (real.length) console.log('\nERRORS:\n' + real.join('\n'));
  console.log(fails || real.length ? '\n有问题' : '\nOpenStreetMap 地图全部通过 ✅');
  process.exit(fails || real.length ? 1 : 0);
})();
