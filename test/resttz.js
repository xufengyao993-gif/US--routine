/*
 * 两件事：
 *  1. 在酒店 / 民宿过夜的时间不该算成「游玩」
 *  2. 跨时区（比如最后一天从旧金山飞马尼拉）时，时间轴仍按出发地走，
 *     但到达地的卡片上要标出当地时刻
 */
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
  await ctx.addInitScript(() => localStorage.setItem('us-routine.config.v2',
    JSON.stringify({ mapProvider: 'osm', orsApiKey: 'K', firebase: {} })));

  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
  await p.goto(PAGE + '?trip=resttz00000000000000001', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);

  const chip = async label => {
    const el = p.locator('.summary-chip', { hasText: label });
    return (await el.count()) ? (await el.first().locator('.summary-value').textContent()) : null;
  };
  const editStop = async i => {
    await p.locator('.stop').nth(i).locator('button', { hasText: '编辑' }).click();
    await p.waitForTimeout(200);
  };
  const saveStop = async () => {
    await p.locator('#stopDialog button[type="submit"]').click();
    await p.waitForTimeout(500);
  };

  /* ---------- 1. 住宿时间不算游玩 ---------- */
  const playBefore = await chip('游玩');
  ok((await chip('休息')) === null, '示例行程里没有过夜住宿，不显示「休息」格子');

  // 把第一个点改成住宿并住 10 小时（模拟"晚上回民宿睡觉"）
  await editStop(0);
  await p.selectOption('#f-category', 'hotel');
  await p.waitForTimeout(150);
  ok(await p.locator('#f-rest').isChecked(), '选成「住宿」时，「算休息」自动打勾');
  await p.fill('#f-stay', '600');
  await saveStop();

  const playAfter = await chip('游玩');
  const restAfter = await chip('休息');
  ok(restAfter === '10 小时', '住的 600 分钟进了「休息」：' + restAfter);
  ok(playAfter === playBefore, '「游玩」没有因为睡觉而变多：' + playBefore + ' → ' + playAfter);
  ok(await p.locator('.stop').first().locator('.badge-rest').isVisible(), '卡片上标出「休息，不算游玩」');

  // 手动覆盖：住宿也能标回游玩
  await editStop(0);
  await p.uncheck('#f-rest');
  await saveStop();
  ok((await chip('休息')) === null, '取消勾选后「休息」格子消失');
  ok((await chip('游玩')) !== playAfter, '这 600 分钟回到了游玩里');
  await editStop(0);
  await p.check('#f-rest');
  await saveStop();

  // 反向：非住宿的点也能标成休息（机场候机）
  await editStop(1);
  await p.selectOption('#f-category', 'transport');
  await p.waitForTimeout(150);
  ok(!(await p.locator('#f-rest').isChecked()), '交通类默认不算休息');
  await p.check('#f-rest');
  await saveStop();
  ok(await p.locator('.stop').nth(1).locator('.badge-rest').isVisible(), '候机也能手动标成休息');

  /* ---------- 2. 跨时区 ---------- */
  // 跨时区通常发生在最后一天（飞回去），而且「新增一天」是接在最后一天后面的，
  // 所以这部分在最后一天上做
  const dayTabs = p.locator('.daytab:not(.daytab-add)');
  await dayTabs.nth((await dayTabs.count()) - 1).click();
  await p.waitForTimeout(600);

  // 这天按洛杉矶时间走
  const tzInput = p.locator('.day-inputs input[list="tzList"]');
  await tzInput.fill('America/Los_Angeles');
  await tzInput.press('Tab');
  await p.waitForTimeout(600);

  // 最后一个点改成马尼拉：手填 14h45m 的飞行时间 + 当地时区
  const last = (await p.locator('.stop').count()) - 1;
  await editStop(last);
  await p.fill('#f-name', 'Manila 马尼拉');
  await p.fill('#f-travel', '885');
  await p.fill('#f-tz', 'Asia/Manila');
  await p.waitForTimeout(200);
  const tzNote = await p.locator('#tz-status').textContent();
  ok(/这里是/.test(tzNote), '填时区时当场给出对照：' + tzNote.trim());
  await saveStop();

  const card = p.locator('.stop').nth(last);
  const localLine = card.locator('.stop-local');
  ok(await localLine.isVisible(), '到达地卡片上多了一行当地时间');
  const localText = await localLine.textContent();
  ok(/Manila当地/.test(localText), '写明是哪儿的当地时间：' + localText.trim());

  // 时间轴本身仍按洛杉矶走：卡片主时刻不等于当地时刻
  const mainTime = await card.locator('.stop-time').textContent();
  ok(mainTime.trim() !== localText.replace('🌐 Manila当地 ', '').trim(),
    '主时间轴没被改成当地时间，仍按出发地：' + mainTime.trim());

  // 那一段路上也标了两头的当地时刻
  const legLocal = p.locator('.leg-local').last();
  ok(await legLocal.isVisible(), '跨时区那段路补了当地时刻');
  const legText = await legLocal.textContent();
  ok(/出发/.test(legText) && /到达/.test(legText), '两头都写了：' + legText.trim());

  // 手填的飞行时间生效，并且标了「手填」
  const legDur = await p.locator('.leg-dur').last().textContent();
  ok(/14 小时 45 分/.test(legDur), '路上时间用的是自己填的 885 分钟：' + legDur.trim());
  ok(await p.locator('.leg-head .badge', { hasText: '手填' }).last().isVisible(), '标出这段是手填的');

  // 同时区的点不该冒出当地时间那一行
  ok((await p.locator('.stop').first().locator('.stop-local').count()) === 0,
    '没跨时区的地点不显示多余的当地时间');

  /* ---------- 3. 新增一天继承时区 ---------- */
  await p.locator('.daytab-add').click();
  await p.waitForTimeout(600);
  const newTz = await p.locator('.day-inputs input[list="tzList"]').inputValue();
  ok(newTz === 'Asia/Manila', '飞过去之后，新的一天默认按马尼拉时间：' + newTz);

  await browser.close();
  console.log(fails ? '\n有 ' + fails + ' 项没通过 ❌' : '\n休息时间与跨时区全部通过 ✅');
  process.exit(fails ? 1 : 0);
})();
