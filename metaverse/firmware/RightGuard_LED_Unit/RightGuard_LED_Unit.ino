// ═══════════════════════════════════════════════════════════════════════
//  RightGuard_LED_Unit.ino · LED 유닛(ESP32 + P10 32×16) · 메타버스 연결 포함 완성본
//  Team Right Guard · 고려대학교 KU CreativeX (CRP)
//
//   센서 유닛 ──블루투스 'X' / 'A' + "RG:POS,x,y"──▶ 이 보드 ──▶ P10 LED (✕ 빨강 / → 초록)
//                                        ▲  USB 시리얼 115200
//                                        └── 메타버스 (Chrome · RightGuard_Metaverse.html)
//
//  기존 코드(핀 맵 · 좌표 번역 · 그림 · 블루투스 'A'/'X')는 그대로이고,
//  [RG] 표시가 붙은 줄만 메타버스 연결을 위해 추가된 것입니다. 별도 파일 없음.
//
//  업로드 후 : 시리얼 모니터 닫기 → 메타버스 노트북에 USB로 꽂기 → Chrome '장치 연결 (USB)'
// ═══════════════════════════════════════════════════════════════════════
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <BluetoothSerial.h>
#include <string.h>

#define PANEL_WIDTH   32
#define PANEL_HEIGHT  16
#define PANELS_NUMBER 1

// [핀 맵 설정]
#define R1_PIN 25
#define G1_PIN 26
#define B1_PIN 27
#define R2_PIN 14
#define G2_PIN 12
#define B2_PIN 13
#define A_PIN  23
#define B_PIN  19
#define C_PIN  5
#define D_PIN  -1
#define E_PIN  -1
#define LAT_PIN 4
#define OE_PIN  15
#define CLK_PIN 16

MatrixPanel_I2S_DMA *dma_display = nullptr;
BluetoothSerial SerialBT;

// [RG] 센서 유닛과 블루투스가 끊겼을 때 ✕를 유지할지 (1 = 보행자 안전 우선, 0 = 기존처럼 마지막 상태 유지)
//      센서 없이 메타버스만으로 시연할 땐 0 으로 두거나, 메타버스 화면에서 '메타버스만' 모드를 고르세요.
#define FAILSAFE_WHEN_SENSOR_LOST 0

// ═══════════════════════════════════════════════════════════════════════
//  [RG] 메타버스 ↔ LED 유닛 연결 모듈 (USB 시리얼)
//   메타버스 → ESP32 : RG:STOP / RG:GO / RG:MODE,MIX|META|REAL / RG:HELLO
//   ESP32 → 메타버스 : RG:HELLO,LED,1.0 / RG:LED,X|ARROW / RG:REAL,1|0 / RG:MODE,…
//   안전 규칙 : 메타버스 신호가 3초 동안 안 오면 (케이블 분리·브라우저 종료) 자체 센서로 복귀
// ═══════════════════════════════════════════════════════════════════════
namespace RGLink {

enum Mode : uint8_t { MIX = 0, META = 1, REAL = 2 };   // 합동 / 메타버스만 / 현실 센서만

struct LinkState {
  Mode mode = MIX;
  bool metaStop = false;          // 메타버스의 최근 판단 (true = 우회전 불가)
  bool everMeta = false;          // 메타버스 신호를 한 번이라도 받았는가
  unsigned long lastMetaMs = 0;   // 마지막 메타버스 신호 시각
  char buf[64];
  uint8_t len = 0;
  int8_t lastReal = -1;           // 마지막으로 보고한 현실 감지값 (-1 = 아직 없음)
  int8_t lastShownX = -1;         // 마지막으로 보고한 LED 모양
  unsigned long lastBeatMs = 0;
};

inline LinkState &S() { static LinkState s; return s; }
inline const char *modeName(Mode m) { return m == META ? "META" : m == REAL ? "REAL" : "MIX"; }
inline void hello() { Serial.println("RG:HELLO,LED,1.0"); }                      // "나 LED 유닛이야"
inline bool metaAlive() { return S().everMeta && (millis() - S().lastMetaMs) < 3000UL; }

inline void reportNow() {                                                       // 현재 상태 재보고
  if (S().lastShownX >= 0) Serial.println(S().lastShownX ? "RG:LED,X" : "RG:LED,ARROW");
  if (S().lastReal >= 0)   Serial.println(S().lastReal ? "RG:REAL,1" : "RG:REAL,0");
  Serial.print("RG:MODE,"); Serial.println(modeName(S().mode));
}

inline void handleLine(const char *line) {                                      // 받은 한 줄 해석
  if (strncmp(line, "RG:", 3) != 0) return;
  const char *c = line + 3;
  if (strcmp(c, "STOP") == 0)       { S().metaStop = true;  S().everMeta = true; S().lastMetaMs = millis(); }
  else if (strcmp(c, "GO") == 0)    { S().metaStop = false; S().everMeta = true; S().lastMetaMs = millis(); }
  else if (strncmp(c, "MODE,", 5) == 0) {
    const char *m = c + 5;
    if (strcmp(m, "META") == 0) S().mode = META;
    else if (strcmp(m, "REAL") == 0) S().mode = REAL;
    else S().mode = MIX;
    Serial.print("RG:MODE,"); Serial.println(modeName(S().mode));
  }
  else if (strcmp(c, "HELLO") == 0) { hello(); reportNow(); }
  else if (strcmp(c, "PING") == 0)  { Serial.println("RG:PONG"); }
}

inline void poll() {                                                            // loop() 맨 앞에서 호출
  LinkState &s = S();
  while (Serial.available() > 0) {
    int ch = Serial.read();
    if (ch < 0) break;
    if (ch == '\r') continue;
    if (ch == '\n') { s.buf[s.len] = 0; if (s.len > 0) handleLine(s.buf); s.len = 0; }
    else if (s.len < sizeof(s.buf) - 1) s.buf[s.len++] = (char)ch;
    else s.len = 0;
  }
}

inline void begin() { hello(); }

inline bool decide(bool realStop) {                                             // 최종 판단
  const bool alive = metaAlive();
  const bool meta  = alive && S().metaStop;
  switch (S().mode) {
    case META: return alive ? meta : realStop;   // 메타버스만 (끊기면 자체 센서로 복귀)
    case REAL: return realStop;                  // 현실 센서만
    default:   return realStop || meta;          // 합동: 하나라도 불가면 ✕
  }
}

inline void reportReal(bool personNow) {                                        // 바뀔 때만 보냄
  if (S().lastReal != (int8_t)personNow) { S().lastReal = personNow; Serial.println(personNow ? "RG:REAL,1" : "RG:REAL,0"); }
}
inline void reportLed(bool showingX) {
  if (S().lastShownX != (int8_t)showingX) { S().lastShownX = showingX; Serial.println(showingX ? "RG:LED,X" : "RG:LED,ARROW"); }
}
inline void heartbeat() {                                                       // 1초마다 상태 재전송
  if (millis() - S().lastBeatMs >= 1000UL) { S().lastBeatMs = millis(); reportNow(); }
}

}  // namespace RGLink
// ═══════════════════════ [RG] 연결 모듈 끝 ═══════════════════════


// ★ 1/4 Scan 특수 지그재그 좌표 번역 함수 (기존 그대로)
void drawPanelPixel(int px, int py, uint16_t color) {
  if (px < 0 || px >= PANEL_WIDTH || py < 0 || py >= PANEL_HEIGHT) return;
  int vx = (px / 8) * 16 + ((py % 8) / 4) * 8 + (px % 8);
  int vy = (py / 8) * 4 + (py % 4);
  dma_display->drawPixel(vx, vy, color);
}

// 안전 상태 그림 (초록색으로 출력됨)
const char *ARROW[PANEL_HEIGHT] = {
  "................................",
  "................##..............",
  "................####............",
  "................######..........",
  "................#######.........",
  "................#########.......",
  "...########################.....",
  "...##########################...",
  "...##########################...",
  "...########################.....",
  "................#########.......",
  "................#######.........",
  "................######..........",
  "................####............",
  "................##..............",
  "................................",
};

// 감지 상태 그림 (빨간색으로 출력됨)
const char *XMARK[PANEL_HEIGHT] = {
  ".......##.............##........",
  "........##...........##.........",
  ".........##.........##..........",
  "..........##.......##...........",
  "...........##.....##............",
  "............##...##.............",
  ".............##.##..............",
  "..............###...............",
  "..............###...............",
  ".............##.##..............",
  "............##...##.............",
  "...........##.....##............",
  "..........##.......##...........",
  ".........##.........##..........",
  "........##...........##.........",
  ".......##.............##........",
};

// 화면 출력 함수 (기존 그대로)
void drawBitmap(const char *bmp[], uint16_t color) {
  dma_display->clearScreen();
  for (int y = 0; y < PANEL_HEIGHT; y++) {
    for (int x = 0; x < PANEL_WIDTH; x++) {
      if (bmp[y][x] == '#') drawPanelPixel(x, y, color);
    }
  }
}

// [RG] 상태 변수
bool   personNow = false;   // 센서 유닛의 최근 판단: 'X' = 사람 있음(true), 'A' = 없음(false)
int8_t shownX    = -1;      // 패널에 지금 그려진 모양 (1 = ✕, 0 = →, -1 = 아직 없음)

void setup() {
  Serial.begin(115200);

  // 1. 블루투스 시작 (장치 이름 고정!)
  SerialBT.begin("RightGuard_LED");
  Serial.println("LED ESP 시작됨. 블루투스 연결을 기다립니다...");

  // 2. 1/4 Scan 패널 DMA 버퍼 설정 (가로 2배, 세로 절반)
  HUB75_I2S_CFG mxconfig(PANEL_WIDTH * 2, PANEL_HEIGHT / 2, PANELS_NUMBER);
  mxconfig.gpio.r1 = R1_PIN; mxconfig.gpio.g1 = G1_PIN; mxconfig.gpio.b1 = B1_PIN;
  mxconfig.gpio.r2 = R2_PIN; mxconfig.gpio.g2 = G2_PIN; mxconfig.gpio.b2 = B2_PIN;
  mxconfig.gpio.a  = A_PIN;  mxconfig.gpio.b  = B_PIN;  mxconfig.gpio.c  = C_PIN;
  mxconfig.gpio.d  = D_PIN;  mxconfig.gpio.e  = E_PIN;
  mxconfig.gpio.lat = LAT_PIN; mxconfig.gpio.oe  = OE_PIN; mxconfig.gpio.clk = CLK_PIN;

  dma_display = new MatrixPanel_I2S_DMA(mxconfig);
  dma_display->begin();
  dma_display->setBrightness8(80);

  // 기본 화면은 화살표(안전)로 시작
  drawBitmap(ARROW, dma_display->color565(0, 255, 0));
  shownX = 0;

  RGLink::begin();   // [RG] 메타버스에 인사
}

void loop() {
  RGLink::poll();    // [RG] 메타버스 명령 읽기 (USB)

  // 블루투스로 수신된 데이터가 있다면 — 'A'/'X' 한 글자 (기존) + "RG:POS,x,y" 좌표 줄 (추가)
  static char line[48];
  static uint8_t n = 0;
  while (SerialBT.available()) {
    char cmd = SerialBT.read(); // 한 글자를 읽음
    if (n == 0 && cmd == 'A') {
      Serial.println("명령 수신: A (안전 - 화살표)");
      personNow = false;
    }
    else if (n == 0 && cmd == 'X') {
      Serial.println("명령 수신: X (위험 - 엑스)");
      personNow = true;
    }
    else if (cmd == '\r') { }
    else if (cmd == '\n') {                       // [RG] 줄이 끝남
      line[n] = 0;
      if (strncmp(line, "RG:POS,", 7) == 0) Serial.println(line);   // 좌표 줄은 그대로 메타버스로 (홀로그램 위치)
      n = 0;
    }
    else if (n < sizeof(line) - 1) line[n++] = cmd;
    else n = 0;                                   // 너무 긴 줄은 버림
  }

  bool realStop = personNow;                      // 현실 센서 기준 판단 (1초 지연은 센서 유닛 쪽에서 처리)
#if FAILSAFE_WHEN_SENSOR_LOST
  if (!SerialBT.hasClient()) realStop = true;     // [RG] 센서 유닛 연결 끊김 → ✕
#endif

  bool showX = RGLink::decide(realStop);          // [RG] 현실 센서 OR 메타버스 → 최종 판단
  if (shownX != (int8_t)showX) {                  // 바뀔 때만 다시 그림
    if (showX) drawBitmap(XMARK, dma_display->color565(255, 0, 0));
    else       drawBitmap(ARROW, dma_display->color565(0, 255, 0));
    shownX = showX;
  }

  RGLink::reportReal(personNow);                  // [RG] 현실 감지 → 메타버스 (홀로그램 보행자)
  RGLink::reportLed(showX);                       // [RG] 실제 LED 모양 → 메타버스 (화면 속 LED 거울)
  RGLink::heartbeat();                            // [RG] 1초마다 상태 재전송
  delay(10);
}
