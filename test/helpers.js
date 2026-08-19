/* 浏览器测试共用的桩：把地图相关的外部请求挡在本地 */
// 中性浅灰的 1x1 图，用来顶替地图瓦片（测试环境访问不了 tile.openstreetmap.org）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN48eY9AAWDAsRbmw5iAAAAAElFTkSuQmCC',
  'base64'
);

/** OpenStreetMap 瓦片：返回 1x1 透明图，避免离线环境刷一屏网络错误 */
async function stubTiles(ctx) {
  await ctx.route('https://tile.openstreetmap.org/**', r =>
    r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
}

/** OpenRouteService：给一条固定的假路线，方便断言 */
async function stubRoutes(ctx, opts) {
  const o = opts || {};
  const minutes = o.minutes || 23;
  const km = o.km || 9.4;
  await ctx.route('https://api.openrouteservice.org/**', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      features: [{
        properties: { summary: { duration: minutes * 60, distance: km * 1000 } },
        geometry: { coordinates: [[-122.41, 37.78], [-122.43, 37.79], [-122.45, 37.80]] }
      }]
    })
  }));
}

/** Photon 地点搜索 */
async function stubSearch(ctx) {
  await ctx.route('https://photon.komoot.io/**', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      features: [
        {
          properties: { name: 'Golden Gate Bridge', osm_key: 'tourism', osm_value: 'attraction',
            city: 'San Francisco', state: 'California', country: 'United States' },
          geometry: { coordinates: [-122.4783, 37.8199] }
        },
        {
          properties: { name: 'Tartine Bakery', osm_key: 'amenity', osm_value: 'cafe',
            housenumber: '600', street: 'Guerrero St', city: 'San Francisco', country: 'United States' },
          geometry: { coordinates: [-122.4241, 37.7614] }
        }
      ]
    })
  }));
}

async function stubAll(ctx) {
  await stubTiles(ctx);
  await stubRoutes(ctx);
  await stubSearch(ctx);
}

module.exports = { PNG, stubTiles, stubRoutes, stubSearch, stubAll };
