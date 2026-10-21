// ─────────────────────────────────────────────────────────────────────
//  MetaverseLink_Test.ino · 5분 연결 시험 (ESP32 보드 하나만 있으면 됨)
//
//  · 메타버스에서 '우회전 불가'가 되면 보드의 파란 LED(GPIO2)가 켜집니다.
//  · 보드의 BOOT 버튼(GPIO0)을 누르고 있으면 '현실 보행자 감지'로 보고되어
//    메타버스 횡단보도에 홀로그램 보행자가 나타납니다.
//
//  사용법
//   1) 이 폴더에 RightGuardLink.h 가 같이 있어야 합니다.
//   2) Arduino IDE → 보드: ESP32 Dev Module → 업로드
//   3) 시리얼 모니터는 닫고, Chrome에서 RightGuard_Metaverse.html → '장치 연결 (USB)'
// ─────────────────────────────────────────────────────────────────────
#include "RightGuardLink.h"

const int LED_PIN = 2;          // 보드 내장 LED (보드마다 다를 수 있음)
const int BOOT_BTN = 0;         // BOOT 버튼 — 누르면 LOW
const unsigned long HOLD_MS = 1000;  // 사람이 사라진 뒤 ✕ 유지 시간 (실제 장치와 동일)

unsigned long lastSeenMs = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BOOT_BTN, INPUT_PULLUP);
  RGLink::begin();
}

void loop() {
  RGLink::poll();  // ① 메타버스 명령 읽기

  bool personNow = digitalRead(BOOT_BTN) == LOW;  // ② '현실 센서' 대신 BOOT 버튼
  if (personNow) lastSeenMs = millis();
  bool realStop = personNow || (millis() - lastSeenMs < HOLD_MS);
  RGLink::reportReal(personNow);

  bool showX = RGLink::decide(realStop);  // ③ 현실 OR 메타버스
  digitalWrite(LED_PIN, showX ? HIGH : LOW);
  RGLink::reportLed(showX);  // ④ 실제 표시 상태 보고

  RGLink::heartbeat();
  delay(5);
}
