// ─────────────────────────────────────────────────────────────────────
//  RightGuard_LED_Metaverse.ino · LED 유닛(ESP32) 통합 예시
//  Team Right Guard · 고려대학교 KU CreativeX (CRP)
//
//  지금 쓰는 LED 유닛 코드 구조(진행일지 9월 4주차 · 10월 1주차)에
//  메타버스 연결을 끼워 넣은 모습입니다. 기존 코드에서 ★ 표시 줄만 옮겨 넣으면 됩니다.
//
//   센서 유닛(ESP32+LD2450) ──블루투스──▶ LED 유닛(이 코드) ──▶ P10 LED (→ / ✕)
//                                          ▲  USB 시리얼
//                                          └── 메타버스 (Chrome · RightGuard_Metaverse.html)
//
//  ▼ 꼭 바꿀 곳
//   1) drawArrow() / drawX() 안에 지금 쓰는 P10 그리기 코드(픽셀 순서 보정 포함)를 넣기
//   2) handleSensorMessage() 를 센서 유닛이 보내는 형식에 맞추기 ('1'/'0' 등)
// ─────────────────────────────────────────────────────────────────────
#include "BluetoothSerial.h"
#include "RightGuardLink.h"  // ★ 1

BluetoothSerial SerialBT;

// 센서가 줄바꿈 없이 '1'/'0' 한 글자로 보내면 1, "DETECT\n" 같은 줄 단위면 0
#define SENSOR_SINGLE_CHAR 1
// 센서 유닛과 블루투스가 끊기면 ✕ (보행자 안전 우선 · 페일세이프)
// 센서 없이 메타버스만으로 시연할 땐 메타버스 화면에서 '메타버스만' 모드를 고르세요.
#define FAILSAFE_WHEN_SENSOR_LOST 1

const unsigned long HOLD_MS = 1000;  // 사람이 사라진 뒤 1초 더 ✕ (10월 1주차 안전 지연)
const int ONBOARD_LED = 2;           // 확인용 보드 LED

bool personNow = false;        // 현실 레이더: 지금 사람이 있는가 (블루투스로 받은 값)
unsigned long lastSeenMs = 0;  // 마지막으로 사람이 보인 시각
int8_t shownX = -1;            // 지금 패널에 그려진 모양 (-1: 아직 없음)

// ── P10 패널 그리기 ── 기존 함수로 바꾸세요 ────────────────────────────
void drawArrow() {
  // 예) matrix.clear(); drawPattern(ARROW_PATTERN, GREEN); matrix.show();
}
void drawX() {
  // 예) matrix.clear(); drawPattern(X_PATTERN, RED); matrix.show();
}

// ── 센서 유닛 메시지 해석 ── 형식에 맞게 수정 ─────────────────────────
void handleSensorMessage(const char *msg) {
  // 좌표 줄은 그대로 메타버스로 넘김 (센서 쪽에서 "RG:POS,x,y" 로 보낼 때)
  if (strncmp(msg, "RG:POS,", 7) == 0) {
    Serial.println(msg);
    return;
  }
  if (!strcmp(msg, "1") || !strcmp(msg, "DETECT") || !strcmp(msg, "ON") || !strcmp(msg, "RG:REAL,1")) personNow = true;
  else if (!strcmp(msg, "0") || !strcmp(msg, "CLEAR") || !strcmp(msg, "OFF") || !strcmp(msg, "RG:REAL,0")) personNow = false;
}

void readSensorBT() {
  static char buf[48];
  static uint8_t n = 0;
  while (SerialBT.available() > 0) {
    char c = (char)SerialBT.read();
    if (c == '\r') continue;
#if SENSOR_SINGLE_CHAR
    if (n == 0 && (c == '1' || c == '0')) {  // 한 글자 신호는 바로 처리
      personNow = (c == '1');
      continue;
    }
#endif
    if (c == '\n') {
      buf[n] = 0;
      if (n) handleSensorMessage(buf);
      n = 0;
    } else if (n < sizeof(buf) - 1) {
      buf[n++] = c;
    } else {
      n = 0;
    }
  }
  if (personNow) lastSeenMs = millis();
}

void setup() {
  Serial.begin(115200);
  pinMode(ONBOARD_LED, OUTPUT);
  SerialBT.begin("RightGuard_LED");  // LED 쪽이 블루투스 서버 (기존과 동일)
  // ... 기존 P10 초기화 코드 ...
  RGLink::begin();  // ★ 2
  drawArrow();
  shownX = 0;
}

void loop() {
  RGLink::poll();  // ★ 3  메타버스 명령 읽기

  readSensorBT();
  bool realStop = personNow || (millis() - lastSeenMs < HOLD_MS);  // 기존 판단 (1초 지연 포함)
#if FAILSAFE_WHEN_SENSOR_LOST
  if (!SerialBT.hasClient()) realStop = true;  // 센서 유닛 연결 끊김 → 안전하게 ✕
#endif

  bool showX = RGLink::decide(realStop);  // ★ 4  현실 OR 메타버스
  if (shownX != (int8_t)showX) {
    if (showX) drawX(); else drawArrow();
    shownX = showX;
  }
  digitalWrite(ONBOARD_LED, showX ? HIGH : LOW);

  RGLink::reportReal(personNow);  // ★ 5  현실 감지 → 메타버스 (홀로그램 보행자)
  RGLink::reportLed(showX);       //       실제 표시 상태 → 메타버스 (화면 속 'LED 거울')
  RGLink::heartbeat();
}
