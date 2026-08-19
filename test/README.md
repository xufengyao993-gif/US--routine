# 测试

## 单元测试（不需要任何依赖）

```bash
node test/unit.js
```

覆盖：v1→v2 数据迁移、order 排序号（插队 / 移到首尾 / 精度耗尽后重排）、
并发补丁路径不相交、时间推算引擎（迟到顺延、早到空档、倒推最晚出发时间）、导出结构。

## 浏览器测试（需要 playwright）

```bash
npm install
npx playwright install chromium     # 若环境已带 Chromium，可设 CHROMIUM_PATH 跳过
python3 -m http.server 8123 &       # 起静态服务
node test/browser.js                # 手机 + 桌面：布局、PWA、弹窗、编辑、排序、持久化
```

## 多人协作测试

不连真的 Firebase：`test/fakedb.js` 是一个内存版实时数据库，
`test/mock-firebase.mjs` 用相同的 SDK 接口把请求打到它上面（由 Playwright 路由拦截注入）。
测的是本项目自己的同步逻辑——补丁路径、远端合并、重绘、在线状态。

```bash
python3 -m http.server 8123 &
node test/fakedb.js &
node test/collab.js
```

会开两个浏览器上下文（小明 / 小红）打开同一条行程链接，验证：
一端改停留时间另一端时间轴自动重算、删点同步、同时改不同的点互不覆盖、
调顺序同步、在线成员头像、"某某正在改"提示、加点与改标题同步。
