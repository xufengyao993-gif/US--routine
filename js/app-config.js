/*
 * 部署时注入的配置（占位文件，值为空时应用走「本地模式」）。
 *
 * 三种填法，优先级从高到低：
 *   1. 分享链接里带的 #cfg=...（朋友点开链接就自动拿到，无需自己配）
 *   2. 应用内「⚙️ 设置」里手填（存在本人浏览器）
 *   3. 本文件（GitHub Actions 部署时会用仓库 Secrets 覆盖它，见 .github/workflows/pages.yml）
 *
 * 本地开发想直接写死，就把值填在这里；但不要把真实 Key 提交到公开仓库，
 * 交给 Actions 从 Secrets 注入更安全。
 */
window.APP_CONFIG = {
  mapsApiKey: '',
  firebase: {
    apiKey: '',
    authDomain: '',
    databaseURL: '',
    projectId: '',
    appId: ''
  }
};
