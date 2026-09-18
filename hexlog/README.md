# HexLog

이동한 곳을 벌집(육각) 격자로 칠해 나가는 위치 기록 지도.

## 실행

정적 파일이라 빌드가 필요 없다. 다만 Service Worker와 위치 권한 때문에
`file://`로는 동작하지 않으니 HTTPS(또는 `localhost`)로 서빙해야 한다.

```sh
cd hexlog && python3 -m http.server 8787
# http://localhost:8787
```

## 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 껍데기와 스타일 |
| `app.js` | 지도, 격자, GPS 추적, GPX 불러오기, 저장 |
| `sw.js` | 오프라인 캐시 (앱 껍데기 + 지도 타일) |
| `vendor/` | MapLibre GL JS 5.24, h3-js 4.5 (오프라인을 위해 로컬 사본) |

- 지도: [MapLibre GL JS](https://maplibre.org) + [OpenFreeMap](https://openfreemap.org)
  벡터 타일(OpenStreetMap 기반, API 키 불필요). 건물은 `fill-extrusion`으로 3D 표시.
- 격자: [Uber H3](https://h3geo.org) 해상도 10 — 육각형 변 약 76m, 폭 약 110~140m, 면적 약 15,000㎡.
- 저장: 방문한 칸은 IndexedDB(`hexlog` / `cells`)에 `{h: H3 인덱스, t: 최초 방문 시각}`으로 남는다.

## 알아 둘 것

- **백그라운드 추적은 불가능하다.** 브라우저는 화면이 켜져 있고 앱이 앞에 떠 있을 때만
  위치를 준다. 특히 iOS Safari가 그렇다. 추적 중에는 Wake Lock으로 화면이 꺼지지 않게
  막지만, 다른 앱으로 전환하면 기록이 끊긴다. 주머니에 넣고 걷는 기록이 필요하면
  Capacitor 등으로 네이티브 래핑을 해야 한다.
- GPS 정확도가 50m보다 나쁜 신호는 버린다. 한 칸이 100m대라 그보다 부정확하면
  엉뚱한 칸이 칠해진다.
- GPX는 점 사이가 30m 넘게 벌어지면 중간을 보간해 빈 칸이 생기지 않게 채운다.
  단 2km를 넘는 간격은 기록 끊김(지하철·차량 이동 등)으로 보고 잇지 않는다.
- 방문한 칸은 전부 한 번에 그린다. 칸이 수만 개로 늘어나면 렌더링이 느려질 수 있고,
  그때는 화면에 보이는 범위만 그리도록 바꿔야 한다.

## 아직 없는 것

- 행정동 경계와 동별 탐험률 (경계 GeoJSON을 받아 와야 한다)
- 동 단위 오프라인 지도 선다운로드 (PMTiles로 가능)
- 사진 썸네일
