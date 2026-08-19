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

## 拖拽排序 / 修改记录 / 撤销

```bash
node test/dragundo.js
```

桌面用鼠标拖、手机用 CDP 触摸事件拖，验证落点指示线、落点计算、
修改记录的内容与时间、逐条撤销、Ctrl+Z 撤销自己最近一次、
删除后撤销能整条还原、目标已被删除时拒绝撤销并说明原因、刷新后记录仍在。

## OpenStreetMap 地图

```bash
node test/osmmap.js
```

用 Playwright 拦掉地图瓦片、OpenRouteService 和 Photon 的请求（沙盒里访问不到），
验证：不填任何 Key 也能出地图、编号图钉与连线、拿到真实耗时后「估算」标签消失、
公交段如实标注估算、地点搜索下拉与回填、餐饮自动归类、设置里切换服务时 Key 输入框的显隐。

`test/helpers.js` 里是这些桩，其他浏览器测试也用它挡掉瓦片请求。

## 日期与自动排序

```bash
node test/datesort.js
```

在 `Asia/Shanghai` 时区下跑（当初出问题的就是东八区）：新增一天的日期是否等于
最后一天 +1、跨月是否正确、改早先某天日期时后面是否跟着顺延、填了固定时间的地点
是否自动挪到正确位置、顺序颠倒时的提示条与手动重排、以及重排能否撤销。

## 交通方式

```bash
node test/modes.js
```

验证下拉里是 Uber / 租车 / 旅行团 / 公交 / 步行 / 骑行 六项、「开车」已移除、
三种车切换后耗时不变且**不会重复查路线**（共用同一条缓存）、导航链接仍用 driving、
「换交通方式」循环覆盖六项，以及老数据里的 `DRIVING` 仍显示为「租车」且编辑框能正确选中。

## 主屏幕图标（独立存储）

```bash
node test/standalone.js
```

模拟「从主屏幕图标启动」：全新的存储 + `navigator.standalone` + 打开不带参数的地址。
验证首次会主动引导粘邀请链接、粘完跳到正确行程且配置一起带过来、之后不再询问、
菜单入口可手动换行程、无效内容给提示、普通浏览器里不打扰。

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
