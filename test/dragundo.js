/* 拖拽排序 + 修改记录 / 撤销（本地模式，不需要 Firebase） */
const { stubTiles, stubWeather } = require('./helpers');
const { chromium, devices } = require('playwright');
const URL = 'http://127.0.0.1:8123/index.html?trip=dragtest0000000000000001';

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  /* ---------- 桌面：鼠标拖拽 ---------- */
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await stubTiles(ctx);
  await stubWeather(ctx);
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);

  const names = async () => (await p.locator('.stop-name').allTextContents()).map(s => s.replace(/^\S+\s/, ''));
  const before = await names();

  // 把第 2 张卡片拖到第 1 位。
  // 起点别选在列表上下边缘 56px 内——那是自动滚动的触发区，一按下去列表就开始滚
  await p.locator('.timeline').evaluate(el => { el.scrollTop = 0; });
  await p.locator('.stop').nth(1).scrollIntoViewIfNeeded();
  await p.waitForTimeout(200);
  const handle = p.locator('.stop').nth(1).locator('.drag-handle');
  const h = await handle.boundingBox();
  const targetCard = await p.locator('.stop').nth(0).boundingBox();
  const vh = p.viewportSize().height;
  ok(h.y > 80 && h.y < vh - 120 && targetCard.y > 60,
     '起点和落点都在视口内且避开自动滚动区（起点 y=' + Math.round(h.y) + '，落点 y=' + Math.round(targetCard.y) + '）');

  await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const y = h.y + (targetCard.y + 6 - h.y) * (i / 8);
    await p.mouse.move(h.x + h.width / 2, y);
    await p.waitForTimeout(20);
  }
  const indicator = await p.locator('.drop-indicator').count();
  ok(indicator === 1, '拖动时出现落点指示线');
  await p.mouse.up();
  await p.waitForTimeout(300);

  const after = await names();
  ok(after[0] === before[1], '拖动后到了第 1 位：' + after[0]);
  ok(after[1] === before[0], '原来第 1 位退到第 2 位');
  /* ---------- 修改记录 ---------- */
  await p.locator('#menuBtn').click();
  await p.locator('#historyBtn').click();
  await p.waitForTimeout(200);
  const first = await p.locator('.history-item .history-summary').first().textContent();
  ok(first.includes('挪到第 1 位'), '记录里有这次拖动：' + first);
  ok((await p.locator('.history-item .history-meta').first().textContent()).includes('刚刚'), '记录显示时间');

  // 撤销这次拖动
  await p.locator('.history-item').first().locator('button', { hasText: '撤销' }).click();
  await p.waitForTimeout(300);
  ok((await names()).join() === before.join(), '撤销后顺序还原');
  ok((await p.locator('.history-item.is-undone').count()) === 1, '原记录被标成已撤销');
  ok((await p.locator('.history-item .history-summary').first().textContent()).includes('撤销了'), '撤销本身也留了一条记录');
  await p.locator('#historyClose').click();

  /* ---------- 编辑 + 快捷键撤销 ---------- */
  const t0 = await p.locator('.stop-time').nth(1).textContent();
  await p.locator('.stop').nth(1).locator('button', { hasText: '编辑' }).click();
  await p.locator('#f-stay').fill('20');
  await p.locator('#stopForm button[type=submit]').click();
  await p.waitForTimeout(300);
  ok((await p.locator('.stop-time').nth(1).textContent()) !== t0, '改了停留时间');

  await p.keyboard.press('Control+z');
  await p.waitForTimeout(400);
  ok((await p.locator('.stop-time').nth(1).textContent()) === t0, 'Ctrl+Z 撤销了刚才的编辑');

  /* ---------- 删除 + 撤销（整条数据要能还原） ---------- */
  const nameGone = (await names())[2];
  const countBefore = await p.locator('.stop').count();
  await p.locator('.stop').nth(2).locator('button', { hasText: '删除' }).click();
  await p.waitForTimeout(300);
  ok((await p.locator('.stop').count()) === countBefore - 1, '删掉了一个地点');
  await p.locator('#undoBtn').click();
  await p.waitForTimeout(400);
  ok((await p.locator('.stop').count()) === countBefore, '撤销后地点回来了');
  ok((await names())[2] === nameGone, '回到原来的位置：' + nameGone);

  /* ---------- 撤不了的情况要拦住 ---------- */
  // 先改一个点，再把它删掉，然后试着撤销那次「改」
  await p.locator('.stop').nth(4).locator('button', { hasText: '编辑' }).click();
  await p.locator('#f-notes').fill('待会儿要被删掉');
  await p.locator('#stopForm button[type=submit]').click();
  await p.waitForTimeout(250);
  await p.locator('.stop').nth(4).locator('button', { hasText: '删除' }).click();
  await p.waitForTimeout(250);

  await p.locator('#menuBtn').click();
  await p.locator('#historyBtn').click();
  await p.waitForTimeout(200);
  const editRow = p.locator('.history-item').filter({ hasText: '改了备注' }).first();
  const undoBtn = editRow.locator('button', { hasText: '撤销' });
  ok((await undoBtn.getAttribute('class')).includes('is-disabled'), '目标已被删除的记录，撤销按钮置灰');
  await undoBtn.click();
  await p.waitForTimeout(200);
  const toastText = await p.locator('#toast').textContent();
  ok(toastText.includes('撤销不了'), '点了会提示原因：' + toastText);
  await p.locator('#historyClose').click();

  /* ---------- 刷新后记录还在 ---------- */
  const historyCount = await p.evaluate(() => JSON.parse(localStorage.getItem('us-routine.history:dragtest0000000000000001') || '[]').length);
  ok(historyCount > 0, '记录写进了本地存储（' + historyCount + ' 条）');
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(500);
  await p.locator('#menuBtn').click();
  await p.locator('#historyBtn').click();
  await p.waitForTimeout(200);
  ok((await p.locator('.history-item').count()) === historyCount, '刷新后记录还在');
  await p.locator('#historyClose').click();

  /* ---------- 手机：触摸拖拽 ---------- */
  const mctx = await browser.newContext(devices['iPhone 13']);
  await stubTiles(mctx);
  await stubWeather(mctx);
  const m = await mctx.newPage();
  m.on('pageerror', e => { console.log('PAGEERROR[mobile]', e.message); fails++; });
  await m.goto(URL, { waitUntil: 'domcontentloaded' });
  await m.waitForTimeout(600);
  const mNames = async () => (await m.locator('.stop-name').allTextContents()).map(s => s.replace(/^\S+\s/, ''));
  const mBefore = await mNames();

  const cdp = await mctx.newCDPSession(m);
  // 往下滚一点，让前两张卡片同时露出来
  await m.locator('.stop').nth(1).scrollIntoViewIfNeeded();
  await m.waitForTimeout(150);
  const mh = await m.locator('.stop').nth(1).locator('.drag-handle').boundingBox();
  const dest = await m.locator('.stop').nth(0).boundingBox();
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }]
  });
  await touch('touchStart', mh.x + mh.width / 2, mh.y + mh.height / 2);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', mh.x + mh.width / 2, mh.y + (dest.y + 6 - mh.y) * (i / 8));
    await m.waitForTimeout(25);
  }
  await touch('touchEnd', 0, 0);
  await m.waitForTimeout(400);
  const mAfter = await mNames();
  ok(mAfter[0] === mBefore[1], '手机上按住手柄拖动也能排序：' + mAfter[0]);

  await browser.close();
  console.log(fails ? '\n有 ' + fails + ' 项失败' : '\n拖拽与撤销全部通过 ✅');
  process.exit(fails ? 1 : 0);
})();
