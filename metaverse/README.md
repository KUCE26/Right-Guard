# Right Guard 메타버스 — 원본 코드

사이트의 `RightGuard_Metaverse.html`(3D 시연)과 `compare.html`(효과 비교)은 이 폴더에서 만들어집니다.
두 파일은 하나로 묶인 결과물이라 직접 고치기 어렵고, 고칠 때는 여기 원본을 고친 뒤 다시 만듭니다.

## 처음 한 번
[Node.js](https://nodejs.org) LTS를 설치하고, 이 폴더에서:

```
npm ci
```

## 고친 뒤 다시 만들기
```
npm run build:site      # RightGuard_Metaverse.html 을 다시 만들어 사이트 파일을 덮어씀
npm run build:compare   # compare.html 을 다시 만듦 (Python 3)
```
`npm run build` 는 `dist/` 에만 만들고 사이트 파일은 건드리지 않습니다. 만든 파일은 브라우저에서 바로 열어 확인할 수 있습니다.

## 폴더
| 위치 | 내용 |
|---|---|
| `src/` | 메타버스 코드 (three.js). `main.js` 시작점, `world.js` 보문역 사거리, `vehicles.js`·`pedestrians.js` 차·사람, `rightguard.js` 장치 판단, `compare.js` 효과 비교 모드 |
| `src/real/` | 실사 표현: 하늘·환경광, 후처리, 건물·도로 질감, 가로수, 신호등·가로등·전신주, 차량·보행자 모델 |
| `src/body.html`, `src/style.css` | 화면(버튼·패널) 구성 |
| `assets/` | 고려대학교 엠블럼·차세대통신학과 이미지 (data URI) |
| `compare/` | 효과 비교 페이지 원본과 미리 돌려 둔 결과(`ref.json`) |
| `firmware/` | ESP32 + LED 장치를 메타버스와 잇는 코드 (USB 시리얼). `RightGuard_LED_Unit/`·`RightGuard_Sensor_Unit/` 은 실제 장치에 올리는 완성본 (파일 하나씩, 라이브러리 외 별도 파일 없음) |

## 주의
- 효과 비교는 같은 seed면 같은 차·사람이 나오도록 난수 순서에 기댑니다. 차·사람 생성 코드(`vehicles.js`, `pedestrians.js`)를 고칠 때는 `Math.random` 사용 횟수가 바뀌지 않게 해야 비교 결과가 그대로 유지됩니다.
- `node_modules/`, `dist/` 는 올리지 않습니다 (`.gitignore`).
