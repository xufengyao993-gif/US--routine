# vendor

第三方库放这里，随仓库一起部署，不依赖 CDN —— 国内网络更稳，Service Worker
也能一起缓存，离线可用。

- **leaflet/** — Leaflet 1.9.4（BSD-2-Clause），来自 npm 包 `leaflet@1.9.4` 的 dist 目录。
  用于 OpenStreetMap 地图显示。升级方式：`npm pack leaflet@<版本>` 后替换 dist 里的文件。
