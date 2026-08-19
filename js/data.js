/* 默认示例行程：旧金山 2 天 + 洛杉矶 1 天。第一次打开时载入，可随意改 / 删。 */
(function (global) {
  'use strict';

  const SAMPLE_TRIP = {
    version: 1,
    title: '美西自由行',
    days: [
      {
        id: 'day-sf1',
        date: '2026-09-12',
        title: '旧金山 · 经典一日',
        startTime: '09:00',
        stops: [
          { id: 's1', name: 'Hotel Zeppelin（联合广场）', category: 'hotel', address: '545 Post St, San Francisco, CA', lat: 37.7879, lng: -122.4103, stayMin: 0, arriveMode: 'DRIVING', notes: '早餐在酒店解决，8:30 出门' },
          { id: 's2', name: 'Golden Gate Bridge 金门大桥', category: 'attraction', address: 'Golden Gate Bridge Welcome Center', lat: 37.8078, lng: -122.4750, stayMin: 95, arriveMode: 'DRIVING', notes: '停 Welcome Center 停车场，风大带外套' },
          { id: 's3', name: 'Palace of Fine Arts 艺术宫', category: 'attraction', address: '3601 Lyon St, San Francisco, CA', lat: 37.8029, lng: -122.4484, stayMin: 50, arriveMode: 'DRIVING', notes: '拍照 30 分钟够' },
          { id: 's4', name: 'Boudin Bakery 酸面包海鲜汤', category: 'food', address: '160 Jefferson St, San Francisco, CA', lat: 37.8080, lng: -122.4177, stayMin: 60, arriveMode: 'DRIVING', fixedStart: '12:30', notes: '午饭 · 建议提前订位' },
          { id: 's5', name: 'Pier 39 渔人码头', category: 'attraction', address: 'Pier 39, San Francisco, CA', lat: 37.8087, lng: -122.4098, stayMin: 90, arriveMode: 'WALKING', notes: '看海狮，走过去 5 分钟' },
          { id: 's6', name: 'Lombard Street 九曲花街', category: 'attraction', address: 'Lombard St, San Francisco, CA', lat: 37.8021, lng: -122.4187, stayMin: 30, arriveMode: 'DRIVING', notes: '开车从坡顶下来' },
          { id: 's6b', name: 'Coit Tower 科伊特塔', category: 'attraction', address: '1 Telegraph Hill Blvd, San Francisco, CA', lat: 37.8024, lng: -122.4058, stayMin: 45, arriveMode: 'DRIVING', notes: '登塔看全景' },
          { id: 's6c', name: 'Chinatown 唐人街', category: 'shopping', address: 'Grant Ave, San Francisco, CA', lat: 37.7941, lng: -122.4078, stayMin: 60, arriveMode: 'WALKING', notes: '走下坡路过去，买点手信' },
          { id: 's7', name: 'Ferry Building 渡轮大厦', category: 'food', address: '1 Ferry Building, San Francisco, CA', lat: 37.7955, lng: -122.3937, stayMin: 80, arriveMode: 'DRIVING', fixedStart: '18:30', notes: '晚饭 · 顺便看落日' },
          { id: 's8', name: '回酒店', category: 'hotel', address: '545 Post St, San Francisco, CA', lat: 37.7879, lng: -122.4103, stayMin: 0, arriveMode: 'DRIVING', notes: '' }
        ]
      },
      {
        id: 'day-sf2',
        date: '2026-09-13',
        title: '旧金山 · 湾区与海岸',
        startTime: '09:00',
        stops: [
          { id: 's9',  name: 'Hotel Zeppelin', category: 'hotel', address: '545 Post St, San Francisco, CA', lat: 37.7879, lng: -122.4103, stayMin: 0, arriveMode: 'DRIVING', notes: '' },
          { id: 's10', name: 'Twin Peaks 双子峰', category: 'outdoor', address: 'Twin Peaks, San Francisco, CA', lat: 37.7544, lng: -122.4477, stayMin: 45, arriveMode: 'DRIVING', notes: '俯瞰全城' },
          { id: 's11', name: 'Mission Dolores Park', category: 'outdoor', address: 'Dolores St & 19th St, San Francisco', lat: 37.7596, lng: -122.4269, stayMin: 40, arriveMode: 'DRIVING', notes: '' },
          { id: 's12', name: 'La Taqueria 墨西哥卷', category: 'food', address: '2889 Mission St, San Francisco, CA', lat: 37.7509, lng: -122.4182, stayMin: 50, arriveMode: 'WALKING', fixedStart: '12:00', notes: '午饭 · 现金友好，排队 15 分钟' },
          { id: 's13', name: 'Painted Ladies 六姐妹', category: 'attraction', address: 'Steiner St, San Francisco, CA', lat: 37.7763, lng: -122.4327, stayMin: 30, arriveMode: 'DRIVING', notes: '' },
          { id: 's14', name: 'Golden Gate Park 金门公园', category: 'outdoor', address: 'Golden Gate Park, San Francisco, CA', lat: 37.7694, lng: -122.4862, stayMin: 90, arriveMode: 'DRIVING', notes: '加州科学院 / 日本茶园二选一' },
          { id: 's15', name: 'Cliff House 看日落', category: 'food', address: '1090 Point Lobos Ave, San Francisco, CA', lat: 37.7784, lng: -122.5137, stayMin: 75, arriveMode: 'DRIVING', fixedStart: '18:00', notes: '晚饭 · 海边日落' }
        ]
      },
      {
        id: 'day-la1',
        date: '2026-09-14',
        title: '洛杉矶 · 海滩到山顶',
        startTime: '09:30',
        stops: [
          { id: 's16', name: 'Santa Monica 酒店', category: 'hotel', address: 'Santa Monica, CA', lat: 34.0195, lng: -118.4912, stayMin: 0, arriveMode: 'DRIVING', notes: '' },
          { id: 's17', name: 'Santa Monica Pier 圣莫尼卡码头', category: 'attraction', address: '200 Santa Monica Pier, CA', lat: 34.0083, lng: -118.4980, stayMin: 80, arriveMode: 'WALKING', notes: '66 号公路终点' },
          { id: 's18', name: 'In-N-Out Burger', category: 'food', address: '922 Gayley Ave, Los Angeles, CA', lat: 34.0621, lng: -118.4468, stayMin: 45, arriveMode: 'DRIVING', fixedStart: '12:30', notes: '午饭 · Animal Style' },
          { id: 's19', name: 'The Getty Center 盖蒂中心', category: 'attraction', address: '1200 Getty Center Dr, Los Angeles, CA', lat: 34.0780, lng: -118.4741, stayMin: 150, arriveMode: 'DRIVING', notes: '免费入场，停车需预约' },
          { id: 's20', name: 'Griffith Observatory 格里菲斯天文台', category: 'attraction', address: '2800 E Observatory Rd, Los Angeles, CA', lat: 34.1184, lng: -118.3004, stayMin: 120, arriveMode: 'DRIVING', fixedStart: '18:00', notes: '看日落 + 夜景，停车位难找提前到' },
          { id: 's21', name: 'Grand Central Market 晚饭', category: 'food', address: '317 S Broadway, Los Angeles, CA', lat: 34.0505, lng: -118.2489, stayMin: 70, arriveMode: 'DRIVING', notes: '晚饭' }
        ]
      }
    ]
  };

  global.SampleTrip = SAMPLE_TRIP;
})(window);
