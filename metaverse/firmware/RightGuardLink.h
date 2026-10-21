// ─────────────────────────────────────────────────────────────────────
//  RightGuardLink.h  ·  Right Guard 메타버스 ↔ LED 유닛(ESP32) 연결 모듈
//  Team Right Guard · 고려대학교 KU CreativeX (CRP)
//
//  메타버스(브라우저, Chrome/Edge)가 USB 시리얼로 보내는 판단을 받아
//  실제 LED(→ / ✕)에 반영하고, 현실 레이더 상태를 메타버스로 돌려보냅니다.
//
//  통신: USB 시리얼 115200 baud, 한 줄 = 한 메시지 ('\n' 으로 끝)
//   메타버스 → ESP32
//     RG:STOP            메타버스 판단 '우회전 불가' (가상 보행자 + 1초 안전 지연 포함)
//     RG:GO              메타버스 판단 '우회전 가능'
//     RG:MODE,MIX        합동: 현실 센서 OR 메타버스 (기본값)
//     RG:MODE,META       메타버스 판단만 따름 (전시장에 사람이 많을 때)
//     RG:MODE,REAL       현실 센서만 따름 (메타버스는 보기만)
//     RG:HELLO           인사 → 장치 정보와 현재 상태를 다시 보고
//   ESP32 → 메타버스
//     RG:HELLO,LED,<버전>
//     RG:LED,X | RG:LED,ARROW     지금 LED에 실제로 표시 중인 모양
//     RG:REAL,1 | RG:REAL,0       현실 레이더(LD2450) 사람 감지 여부 (지연 없는 원래 값)
//     RG:POS,<x_mm>,<y_mm>        (선택) 사람 좌표 → 메타버스 속 위치까지 맞춤
//     RG:MODE,<MIX|META|REAL>
//
//  안전 규칙
//   · 메타버스 신호(RG:STOP/GO)는 1초마다 다시 옵니다. 3초 동안 안 오면
//     (케이블 분리·브라우저 종료) 메타버스 판단은 무시하고 자체 센서로 돌아갑니다.
//   · MIX 모드에서는 둘 중 하나라도 '불가'면 ✕ — 보행자 쪽으로 안전하게 기웁니다.
//
//  기존 코드에 넣는 법 (4줄)
//     #include "RightGuardLink.h"
//     setup():  RGLink::begin();                    // Serial.begin(115200) 뒤에
//     loop():   RGLink::poll();                     // 맨 앞
//               bool showX = RGLink::decide(realStop);  // 기존 판단값을 넣고 결과로 그리기
//               RGLink::reportReal(personNow);  RGLink::reportLed(showX);  RGLink::heartbeat();
// ─────────────────────────────────────────────────────────────────────
#pragma once
#include <Arduino.h>
#include <string.h>

#ifndef RG_LINK_BAUD
#define RG_LINK_BAUD 115200
#endif
#ifndef RG_META_TIMEOUT_MS
#define RG_META_TIMEOUT_MS 3000UL
#endif
#ifndef RG_HEARTBEAT_MS
#define RG_HEARTBEAT_MS 1000UL
#endif
#define RG_LINK_VERSION "1.0"

namespace RGLink {

enum Mode : uint8_t { MIX = 0, META = 1, REAL = 2 };

struct LinkState {
  Mode mode = MIX;
  bool metaStop = false;
  bool everMeta = false;
  unsigned long lastMetaMs = 0;
  char buf[64];
  uint8_t len = 0;
  int8_t lastReal = -1;    // -1 = 아직 보고 안 함
  int8_t lastShownX = -1;
  unsigned long lastBeatMs = 0;
};

inline LinkState &S() {
  static LinkState s;
  return s;
}

inline const char *modeName(Mode m) {
  return m == META ? "META" : m == REAL ? "REAL" : "MIX";
}

inline void hello() {
  Serial.print("RG:HELLO,LED,");
  Serial.println(RG_LINK_VERSION);
}

// 메타버스가 살아 있는가 (최근 3초 안에 STOP/GO를 받았는가)
inline bool metaAlive() {
  return S().everMeta && (millis() - S().lastMetaMs) < RG_META_TIMEOUT_MS;
}

// 현재 상태를 즉시 다시 보고 (연결 직후·HELLO 응답용)
inline void reportNow() {
  if (S().lastShownX >= 0) Serial.println(S().lastShownX ? "RG:LED,X" : "RG:LED,ARROW");
  if (S().lastReal >= 0) Serial.println(S().lastReal ? "RG:REAL,1" : "RG:REAL,0");
  Serial.print("RG:MODE,");
  Serial.println(modeName(S().mode));
}

inline void handleLine(const char *line) {
  if (strncmp(line, "RG:", 3) != 0) return;  // 다른 문자열은 무시
  const char *c = line + 3;
  if (strcmp(c, "STOP") == 0) {
    S().metaStop = true;
    S().everMeta = true;
    S().lastMetaMs = millis();
  } else if (strcmp(c, "GO") == 0) {
    S().metaStop = false;
    S().everMeta = true;
    S().lastMetaMs = millis();
  } else if (strncmp(c, "MODE,", 5) == 0) {
    const char *m = c + 5;
    if (strcmp(m, "META") == 0) S().mode = META;
    else if (strcmp(m, "REAL") == 0) S().mode = REAL;
    else S().mode = MIX;
    Serial.print("RG:MODE,");
    Serial.println(modeName(S().mode));
  } else if (strcmp(c, "HELLO") == 0) {
    hello();
    reportNow();
  } else if (strcmp(c, "PING") == 0) {
    Serial.println("RG:PONG");
  }
}

// USB 시리얼에서 메타버스 명령 읽기 — loop() 맨 앞에서 매번 호출 (멈추지 않음)
inline void poll() {
  LinkState &s = S();
  while (Serial.available() > 0) {
    int ch = Serial.read();
    if (ch < 0) break;
    if (ch == '\r') continue;
    if (ch == '\n') {
      s.buf[s.len] = 0;
      if (s.len > 0) handleLine(s.buf);
      s.len = 0;
    } else if (s.len < sizeof(s.buf) - 1) {
      s.buf[s.len++] = (char)ch;
    } else {
      s.len = 0;  // 너무 긴 줄은 버림
    }
  }
}

inline void begin() {
  hello();
}

// 최종 판단: realStop = 기존 코드가 계산한 '현실 센서 기준 우회전 불가'(1초 지연 포함)
inline bool decide(bool realStop) {
  const bool alive = metaAlive();
  const bool meta = alive && S().metaStop;
  switch (S().mode) {
    case META: return alive ? meta : realStop;  // 메타버스가 끊기면 자체 센서로 복귀
    case REAL: return realStop;
    default:   return realStop || meta;         // 합동: 하나라도 불가면 ✕
  }
}

// 현실 레이더의 '지금' 감지 여부 (지연 없는 값) — 바뀔 때만 보냄
inline void reportReal(bool personNow) {
  if (S().lastReal != (int8_t)personNow) {
    S().lastReal = personNow;
    Serial.println(personNow ? "RG:REAL,1" : "RG:REAL,0");
  }
}

// LED에 실제로 그린 모양 — 바뀔 때만 보냄
inline void reportLed(bool showingX) {
  if (S().lastShownX != (int8_t)showingX) {
    S().lastShownX = showingX;
    Serial.println(showingX ? "RG:LED,X" : "RG:LED,ARROW");
  }
}

// (선택) LD2450 좌표(mm) — 너무 자주 보내지 않도록 최소 100 ms 간격
inline void reportPos(int xmm, int ymm) {
  static unsigned long last = 0;
  if (millis() - last < 100) return;
  last = millis();
  Serial.printf("RG:POS,%d,%d\n", xmm, ymm);
}

// 1초마다 현재 상태 재전송 (메타버스를 나중에 연결해도 바로 동기화)
inline void heartbeat() {
  if (millis() - S().lastBeatMs >= RG_HEARTBEAT_MS) {
    S().lastBeatMs = millis();
    reportNow();
  }
}

}  // namespace RGLink
