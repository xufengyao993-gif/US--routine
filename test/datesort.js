/* 新的一天日期自动 +1、日期顺延、按固定时间自动重排 */
const { stubTiles, stubWeather } = require('./helpers');
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8123/index.html?trip=datesort000000000000001';

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  // 用东八区跑，这是当初出问题的时区
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
  await stubTiles(ctx);
  await stubWeather(ctx);
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);

  const dayDate = () => p.locator('.day-inputs input[type=date]').inputValue();
  const tabDates = () => p.locator('.daytab-date').allTextContents();

  /* --- 新的一天日期自动接在最后一天后面 --- */
  const nextOf = iso => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + 1);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };

  // 先选中最后一天，记下它的日期
  const lastTab = (await p.locator('.daytab').count()) - 2;   // 最后一个是「+ 新的一天」
  await p.locator('.daytab').nth(lastTab).click();
  await p.waitForTimeout(300);
  const lastDate = await dayDate();

  const tabsBefore = await p.locator('.daytab').count();
  await p.locator('.daytab-add').click();
  await p.waitForTimeout(400);
  ok((await p.locator('.daytab').count()) === tabsBefore + 1, '新增了一天');
  ok((await dayDate()) === nextOf(lastDate), '新的一天 = 最后一天 +1：' + lastDate + ' → ' + await dayDate());

  const d2 = await dayDate();
  await p.locator('.daytab-add').click();
  await p.waitForTimeout(400);
  ok((await dayDate()) === nextOf(d2), '再加一天继续往后：' + d2 + ' → ' + await dayDate());

  // 跨月
  await p.locator('.day-inputs input[type=date]').fill('2026-09-30');
  await p.locator('.day-inputs input[type=date]').blur();
  await p.waitForTimeout(300);
  await p.locator('.daytab-add').click();
  await p.waitForTimeout(400);
  ok((await dayDate()) === '2026-10-01', '跨月也对：' + await dayDate());

  /* --- 改前面某天的日期，后面连着的天跟着顺延 --- */
  await p.locator('.daytab').nth(0).click();
  await p.waitForTimeout(300);
  await p.locator('.day-inputs input[type=date]').fill('2026-09-15');   // 整体推迟 3 天
  await p.locator('.day-inputs input[type=date]').blur();
  await p.waitForTimeout(500);
  await p.locator('.daytab').nth(1).click();
  await p.waitForTimeout(300);
  ok((await dayDate()) === '2026-09-16', 'Day1 推迟 3 天后 Day2 跟着顺延：' + await dayDate());
  await p.locator('.daytab').nth(2).click();
  await p.waitForTimeout(300);
  ok((await dayDate()) === '2026-09-17', 'Day3 也顺延：' + await dayDate());

  /* --- 按固定时间自动重排 --- */
  await p.locator('.daytab').nth(0).click();
  await p.waitForTimeout(300);
  const names = async () => (await p.locator('.stop-name').allTextContents()).map(s => s.replace(/^\S+\s/, ''));

  // 示例第一天：给最后一个点设一个很早的固定时间，它应该自动往前挪
  const before = await names();
  const lastIdx = before.length - 1;
  await p.locator('.stop').nth(lastIdx).locator('button', { hasText: '编辑' }).click();
  await p.locator('#f-name').fill('早餐店');
  await p.locator('#f-fixed').fill('09:30');
  await p.locator('#stopForm button[type=submit]').click();
  await p.waitForTimeout(700);

  const after = await names();
  const pos = after.findIndex(n => n.includes('早餐店'));
  ok(pos >= 0 && pos < lastIdx, '设了 09:30 之后自动往前挪到第 ' + (pos + 1) + ' 位（原来是第 ' + (lastIdx + 1) + ' 位）');
  const toastText = await p.locator('#toast').textContent();
  ok(toastText.includes('09:30') && toastText.includes('移到'), '有提示告诉你挪到哪了：' + toastText);

  // 挪完之后固定时间应该是从早到晚的
  const fixedOrder = await p.evaluate(() => {
    return Array.from(document.querySelectorAll('.stop')).map(el => {
      const b = el.querySelector('.badge-fixed');
      return b ? b.textContent.replace('固定 ', '') : null;
    }).filter(Boolean);
  });
  const sortedOk = fixedOrder.every((t, i) => i === 0 || t >= fixedOrder[i - 1]);
  ok(sortedOk, '重排后固定时间从早到晚：' + fixedOrder.join(' → '));

  /* --- 撤销要能还原 --- */
  await p.locator('#undoBtn').click();
  await p.waitForTimeout(500);
  const afterUndo = await names();
  ok(afterUndo.findIndex(n => n.includes('早餐店')) === lastIdx, '撤销后回到原来的位置');

  /* --- 撤销之后顺序又是乱的，这时该出现重排入口 --- */
  ok((await p.locator('.warn-bar-action').count()) === 1, '顺序颠倒时出现「按时间重排」提示条');
  await p.locator('.warn-bar-action .link-btn').click();
  await p.waitForTimeout(600);
  ok((await p.locator('.warn-bar-action').count()) === 0, '点「按时间重排」后提示消失');
  const finalNames = await names();
  ok(finalNames.findIndex(n => n.includes('早餐店')) < lastIdx, '手动重排也把早餐店挪到了前面');

  /* --- 已经排好时再点一次，应该告诉你不用排 --- */
  await p.locator('#menuBtn').click();
  await p.locator('#sortBtn').click();
  await p.waitForTimeout(400);
  ok((await p.locator('#toast').textContent()).includes('已经是按时间排好的了'), '已排好时给出提示');

  await browser.close();
  console.log(fails ? '\n有 ' + fails + ' 项失败' : '\n日期与排序全部通过 ✅');
  process.exit(fails ? 1 : 0);
})();
