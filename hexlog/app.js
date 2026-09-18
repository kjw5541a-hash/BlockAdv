/* HexLog — 이동한 곳을 벌집(H3) 격자로 색칠해 기록하는 지도.
   지도: MapLibre GL JS + OpenFreeMap(OSM) 벡터 타일, 건물은 fill-extrusion으로 3D 표시.
   격자: Uber H3 해상도 10 (육각형 변 약 76m, 폭 약 110~140m). */

const H3_RES = 10;
const ACCURACY_LIMIT_M = 50;   // 이보다 부정확한 GPS 신호는 버린다
const GPX_STEP_M = 30;         // GPX 점 사이를 이 간격으로 보간해 빈 칸이 생기지 않게 한다
const GPX_GAP_M = 2000;        // 이보다 먼 두 점은 기록 끊김으로 보고 잇지 않는다
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const HEX_COLOR = '#ff7a18';

const $ = (id) => document.getElementById(id);

/* ---------- 저장소 (IndexedDB) ---------- */

const store = {
  db: null,

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('hexlog', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('cells', { keyPath: 'h' });
      req.onsuccess = () => { store.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },

  /* 저장된 모든 칸을 Map<h3index, 최초방문시각>으로 반환 */
  loadAll() {
    return new Promise((resolve, reject) => {
      const req = store.db.transaction('cells').objectStore('cells').getAll();
      req.onsuccess = () => resolve(new Map(req.result.map((r) => [r.h, r.t])));
      req.onerror = () => reject(req.error);
    });
  },

  put(records) {
    return new Promise((resolve, reject) => {
      const tx = store.db.transaction('cells', 'readwrite');
      const os = tx.objectStore('cells');
      for (const r of records) os.put(r);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
};

/* ---------- 방문 칸 관리 ---------- */

const visited = new Map(); // h3index -> 최초 방문 시각(ms)

function hexFeature(h) {
  // formatAsGeoJson=true면 [lng, lat] 순서에 고리가 닫힌 채로 돌아온다.
  const ring = h3.cellToBoundary(h, true);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function visitedGeoJSON() {
  return { type: 'FeatureCollection', features: [...visited.keys()].map(hexFeature) };
}

/* 새로 방문한 칸만 저장하고 화면을 갱신한다. 새로 추가된 개수를 반환. */
async function addCells(cells, at = Date.now()) {
  const fresh = [];
  for (const h of cells) {
    if (visited.has(h)) continue;
    visited.set(h, at);
    fresh.push({ h, t: at });
  }
  if (!fresh.length) return 0;
  await store.put(fresh);
  refreshMap();
  refreshStats();
  return fresh.length;
}

function refreshStats() {
  const dayStart = new Date().setHours(0, 0, 0, 0);
  let today = 0;
  for (const t of visited.values()) if (t >= dayStart) today++;
  $('stat-total').textContent = visited.size.toLocaleString('ko-KR');
  $('stat-today').textContent = today.toLocaleString('ko-KR');
}

/* ---------- 지도 ---------- */

let map = null;
let mapReady = false;
let marker = null;
let following = true;

function refreshMap() {
  if (!mapReady) return;
  map.getSource('visited').setData(visitedGeoJSON());
}

function addHexLayers() {
  map.addSource('visited', { type: 'geojson', data: visitedGeoJSON() });

  // 색칠한 칸은 건물보다 아래에 깔아서 3D 건물이 그 위로 솟아 보이게 한다.
  const firstExtrusion = map.getStyle().layers.find((l) => l.type === 'fill-extrusion');
  const before = firstExtrusion ? firstExtrusion.id : undefined;

  map.addLayer({
    id: 'visited-fill',
    type: 'fill',
    source: 'visited',
    paint: { 'fill-color': HEX_COLOR, 'fill-opacity': 0.38 },
  }, before);

  map.addLayer({
    id: 'visited-line',
    type: 'line',
    source: 'visited',
    paint: { 'line-color': HEX_COLOR, 'line-width': 1, 'line-opacity': 0.55 },
  }, before);

  // 스타일에 3D 건물이 없으면 직접 얹는다 (OpenMapTiles 스키마).
  if (!firstExtrusion && map.getSource('openmaptiles')) {
    map.addLayer({
      id: 'hexlog-buildings',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 14,
      paint: {
        'fill-extrusion-color': '#c8ccd4',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.85,
      },
    });
  }
}

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: STYLE_URL,
    center: [127.0276, 37.4979], // 강남역. 첫 위치를 잡기 전까지의 임시 중심
    zoom: 16,
    pitch: 50,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.on('dragstart', () => { following = false; });

  map.on('load', () => {
    addHexLayers();
    mapReady = true;
    $('overlay').classList.add('hidden');
  });

  map.on('error', (e) => {
    // 타일 한 장이 실패한 정도로 앱을 멈추지는 않는다. 스타일 자체를 못 받으면 알린다.
    if (!mapReady) showFatal('지도를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.<br><small>' +
      ((e.error && e.error.message) || '') + '</small>');
  });
}

function showFatal(html) {
  $('overlay').classList.remove('hidden');
  $('overlay-msg').innerHTML = '<span class="err">' + html + '</span>';
}

function moveMarker(lat, lng) {
  if (!marker) {
    const el = document.createElement('div');
    el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#2e7dff;' +
      'border:3px solid #fff;box-shadow:0 0 0 2px rgba(46,125,255,0.35);';
    marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
  } else {
    marker.setLngLat([lng, lat]);
  }
}

/* ---------- GPS 추적 ---------- */

const tracker = {
  watchId: null,
  wakeLock: null,

  get active() { return this.watchId !== null; },

  async start() {
    if (!navigator.geolocation) return toast('이 브라우저는 위치 기능을 지원하지 않습니다.');
    this.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 20000,
    });
    following = true;
    await this.lockScreen();
    syncTrackButton();
    toast('추적을 시작했습니다. 화면을 켜 둔 동안에만 기록됩니다.');
  },

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
    $('stat-gps').textContent = 'GPS 꺼짐';
    syncTrackButton();
  },

  /* 추적 중에는 화면이 꺼지지 않게 한다. 브라우저가 거부해도 추적 자체는 계속한다. */
  async lockScreen() {
    if (!navigator.wakeLock) return;
    try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* 무시 */ }
  },
};

async function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  moveMarker(lat, lng);
  if (following && mapReady) map.easeTo({ center: [lng, lat], duration: 600 });

  if (accuracy > ACCURACY_LIMIT_M) {
    $('stat-gps').textContent = `신호 약함 ±${Math.round(accuracy)}m`;
    return;
  }
  $('stat-gps').textContent = `±${Math.round(accuracy)}m`;
  await addCells([h3.latLngToCell(lat, lng, H3_RES)]);
}

function onPositionError(err) {
  const msg = err.code === err.PERMISSION_DENIED
    ? '위치 권한이 거부되었습니다.'
    : '위치를 가져오지 못했습니다.';
  $('stat-gps').textContent = msg;
  toast(msg);
}

function syncTrackButton() {
  const btn = $('btn-track');
  btn.textContent = tracker.active ? '■ 추적 중지' : '● 추적 시작';
  btn.classList.toggle('on', tracker.active);
}

/* 화면을 다시 켰을 때 wake lock이 풀려 있으면 다시 잡는다. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tracker.active && !tracker.wakeLock) {
    tracker.lockScreen();
  }
});

/* ---------- GPX 불러오기 ---------- */

function metersBetween(a, b) {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const lat = ((a[0] + b[0]) / 2) * (Math.PI / 180);
  const x = dLng * Math.cos(lat);
  return Math.hypot(dLat, x) * R;
}

function pointsIn(el) {
  const out = [];
  for (const p of el.getElementsByTagName('*')) {
    const name = p.localName;
    if (name !== 'trkpt' && name !== 'rtept' && name !== 'wpt') continue;
    const lat = parseFloat(p.getAttribute('lat'));
    const lng = parseFloat(p.getAttribute('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lng)) out.push([lat, lng]);
  }
  return out;
}

/* GPX를 이어진 구간들로 나눈다. 서로 다른 구간 사이는 잇지 않는다. */
function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('GPX 형식이 아닙니다.');

  const segments = [];
  for (const el of doc.getElementsByTagName('*')) {
    if (el.localName === 'trkseg' || el.localName === 'rte') {
      const pts = pointsIn(el);
      if (pts.length) segments.push(pts);
    }
  }
  // 트랙도 경로도 없으면 단독 웨이포인트만이라도 찍어 준다.
  if (!segments.length) {
    for (const p of pointsIn(doc.documentElement)) segments.push([p]);
  }
  return segments;
}

/* 점 사이가 벌어져 있으면 중간 점을 채워 빠지는 칸이 없게 한다. */
function cellsForSegment(seg) {
  const cells = new Set();
  for (let i = 0; i < seg.length; i++) {
    cells.add(h3.latLngToCell(seg[i][0], seg[i][1], H3_RES));
    const next = seg[i + 1];
    if (!next) break;

    const dist = metersBetween(seg[i], next);
    if (dist <= GPX_STEP_M || dist > GPX_GAP_M) continue;

    const steps = Math.ceil(dist / GPX_STEP_M);
    for (let k = 1; k < steps; k++) {
      const f = k / steps;
      cells.add(h3.latLngToCell(
        seg[i][0] + (next[0] - seg[i][0]) * f,
        seg[i][1] + (next[1] - seg[i][1]) * f,
        H3_RES,
      ));
    }
  }
  return cells;
}

async function importGpx(file) {
  toast(`${file.name} 읽는 중…`);
  let segments;
  try {
    segments = parseGpx(await file.text());
  } catch (e) {
    return toast(e.message);
  }
  if (!segments.length) return toast('GPX에 위치 정보가 없습니다.');

  const cells = new Set();
  for (const seg of segments) for (const c of cellsForSegment(seg)) cells.add(c);

  const added = await addCells([...cells]);
  toast(added ? `${added.toLocaleString('ko-KR')}칸을 새로 칠했습니다.` : '이미 다 칠한 구간입니다.');

  if (added && mapReady) {
    following = false;
    map.fitBounds(boundsOf(cells), { padding: 60, maxZoom: 16, duration: 900 });
  }
}

function boundsOf(cells) {
  const b = new maplibregl.LngLatBounds();
  for (const h of cells) {
    const [lat, lng] = h3.cellToLatLng(h);
    b.extend([lng, lat]);
  }
  return b;
}

/* ---------- UI ---------- */

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function bindUI() {
  $('btn-track').addEventListener('click', () => {
    tracker.active ? tracker.stop() : tracker.start();
  });

  $('btn-locate').addEventListener('click', () => {
    following = true;
    if (!navigator.geolocation) return toast('이 브라우저는 위치 기능을 지원하지 않습니다.');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        moveMarker(pos.coords.latitude, pos.coords.longitude);
        map.easeTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 16.5, duration: 800 });
      },
      onPositionError,
      { enableHighAccuracy: true, timeout: 20000 },
    );
  });

  $('btn-gpx').addEventListener('click', () => $('gpx-input').click());
  $('gpx-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importGpx(file);
    e.target.value = ''; // 같은 파일을 다시 고를 수 있게 비워 둔다
  });
}

/* ---------- 시작 ---------- */

async function main() {
  bindUI();
  try {
    await store.open();
    for (const [h, t] of await store.loadAll()) visited.set(h, t);
  } catch (e) {
    return showFatal('저장소를 열지 못했습니다.<br><small>' + e.message + '</small>');
  }
  refreshStats();
  initMap();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main();
