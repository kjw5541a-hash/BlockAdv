/* 행정동 경계 GeoJSON(vuski/admdongkor)을 앱이 쓰는 시군구별 파일로 가공한다.

   사용법 (hexlog/ 에서):
     npm i --no-save mapshaper
     node tools/build-dong.mjs HangJeongDong_ver20260701.geojson

   결과:
     data/dong/index.json    시군구 목록 [{c: 시군구코드, n: 이름, b: [서, 남, 동, 북]}]
     data/dong/<시군구>.json  그 시군구의 행정동 FeatureCollection
                              properties: {c: 행정동코드, n: 전체 이름, k: 동 안의 H3 칸 수} */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// 칸 수가 앱과 정확히 같도록 앱이 쓰는 h3 사본을 그대로 쓴다.
const require = createRequire(import.meta.url);
const h3 = require('../vendor/h3-js.umd.js');

const H3_RES = 10;             // app.js의 H3_RES와 같아야 한다
const SIMPLIFY_M = 10;         // 경계 단순화 간격(m)
const src = process.argv[2];
if (!src) { console.error('원본 GeoJSON 경로를 주세요.'); process.exit(1); }

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'dong');
const tmp = path.join(outDir, '.simplified.geojson');
fs.mkdirSync(outDir, { recursive: true });

execFileSync('npx', ['mapshaper', src,
  '-simplify', `interval=${SIMPLIFY_M}`, 'keep-shapes',
  '-filter-fields', 'adm_cd2,adm_nm,sgg,sidonm,sggnm',
  '-o', tmp, 'precision=0.00001', 'format=geojson',
], { stdio: 'inherit' });

const { features } = JSON.parse(fs.readFileSync(tmp, 'utf8'));
fs.unlinkSync(tmp);

const polygonsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

const groups = new Map();
for (const f of features) {
  const p = f.properties;
  const cells = new Set();
  for (const poly of polygonsOf(f.geometry)) {
    for (const c of h3.polygonToCells(poly, H3_RES, true)) cells.add(c);
  }
  if (!groups.has(p.sgg)) {
    groups.set(p.sgg, { name: `${p.sidonm} ${p.sggnm}`, features: [], b: [180, 90, -180, -90] });
  }
  const g = groups.get(p.sgg);
  for (const poly of polygonsOf(f.geometry)) {
    for (const [lng, lat] of poly[0]) {
      g.b[0] = Math.min(g.b[0], lng); g.b[1] = Math.min(g.b[1], lat);
      g.b[2] = Math.max(g.b[2], lng); g.b[3] = Math.max(g.b[3], lat);
    }
  }
  g.features.push({
    type: 'Feature',
    properties: { c: p.adm_cd2, n: p.adm_nm, k: cells.size },
    geometry: f.geometry,
  });
}

const index = [];
for (const [sgg, g] of [...groups].sort()) {
  fs.writeFileSync(path.join(outDir, `${sgg}.json`),
    JSON.stringify({ type: 'FeatureCollection', features: g.features }));
  index.push({ c: sgg, n: g.name, b: g.b.map((v) => +v.toFixed(5)) });
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index));
console.log(`시군구 ${index.length}개, 행정동 ${features.length}개 → ${outDir}`);
