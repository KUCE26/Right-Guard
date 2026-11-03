// ═══════════════════════════════════════════════════════════════════════
//  RightGuard_Sensor_Unit.ino · 센서 유닛(ESP32 + LD2450) · 좌표 전송 포함 완성본
//  Team Right Guard · 고려대학교 KU CreativeX (CRP)
//
//   LD2450 ──UART──▶ 이 보드 ──블루투스──▶ LED 유닛 ──USB──▶ 메타버스
//                                 'X' / 'A'            (사람 있음 / 없음, 기존과 동일)
//                                 "RG:POS,x1,y1,x2,y2,x3,y3\n"  (레이더가 보는 사람 모두의 좌표 mm, 가까운 순 · 새로 추가)
//
//  기존 코드는 그대로이고 [RG] 표시 줄만 추가됐습니다.
//   · 좌표를 보내면 메타버스 횡단보도에 하늘색 홀로그램 보행자가 사람 수만큼(최대 3명) '그 자리'에 나타납니다.
//   · 좌표 줄은 'X'/'A'만 아는 예전 LED 코드가 받아도 무시되므로 안전합니다.
//
//  좌표 기준 (LD2450): x = 좌우 mm (센서 정면에서 오른쪽 +), y = 앞쪽 거리 mm
//   메타버스에서 좌우가 반대로 보이면 아래 MIRROR_X 를 1 로 바꾸세요.
// ═══════════════════════════════════════════════════════════════════════
#include <BluetoothSerial.h>

BluetoothSerial SerialBT;
bool connected = false;

uint8_t buf[30];
int idx = 0;

char lastState = ' ';            // 이전 상태 저장용
unsigned long lastSendTime = 0;  // 마지막 전송 시간 저장용

// [RG] 추가 설정
const unsigned long HOLD_MS = 1000;   // 사람이 사라진 뒤 1초 더 'X' 유지 (안전 지연). 0 이면 즉시 'A'
const unsigned long POS_MS  = 100;    // 좌표 전송 간격 (ms) — 10 Hz
#define MIRROR_X 0                    // 메타버스에서 좌우가 반대면 1
unsigned long lastSeenMs = 0;         // 마지막으로 사람이 보인 시각
unsigned long lastPosMs  = 0;         // 마지막 좌표 전송 시각
unsigned long lastRetryMs = 0;        // 마지막 재연결 시도 시각

void setup() {
  Serial.begin(115200);
  Serial2.begin(256000, SERIAL_8N1, 16, 17);   // 센서TX→16, 센서RX→17

  // 송신기(Master) 모드로 블루투스 시작
  SerialBT.begin("RightGuard_Sensor", true);
  Serial.println("\n센서 ESP 시작됨. LED 패널(RightGuard_LED)을 찾습니다...");

  // LED ESP에 연결 시도 (LED ESP가 먼저 켜져 있어야 연결이 빠릅니다)
  connected = SerialBT.connect("RightGuard_LED");
  if (connected) {
    Serial.println("✅ LED ESP에 성공적으로 연결되었습니다!");
  } else {
    Serial.println("❌ 연결 실패. (Loop에서 재연결 시도합니다)");
  }
}

// [RG] LD2450 좌표 해석: 최상위 비트가 1이면 양수, 0이면 음수 (부호-크기 방식)
int16_t ld2450Value(uint8_t lo, uint8_t hi) {
  uint16_t raw = lo | (hi << 8);
  int16_t v = raw & 0x7FFF;
  return (raw & 0x8000) ? v : -v;
}

void parseFrame(uint8_t* f) {
  bool found = false;
  // [RG] 레이더가 보는 사람들의 좌표 (최대 3명)
  int16_t px[3], py[3];
  long pd[3];
  int n = 0;

  // 3명의 타겟 중 1명이라도 좌표가 0이 아니면 '사람 있음'으로 간주
  for (int t = 0; t < 3; t++) {
    int o = 4 + t * 8;
    int16_t rx = f[o]   | (f[o+1] << 8);
    int16_t ry = f[o+2] | (f[o+3] << 8);

    if (rx != 0 || ry != 0) {
      found = true;
      // [RG] 부호를 바로잡은 좌표를 모음
      px[n] = ld2450Value(f[o], f[o+1]);
      py[n] = ld2450Value(f[o+2], f[o+3]);
      pd[n] = (long)px[n] * px[n] + (long)py[n] * py[n];
      n++;
    }
  }
  // [RG] 가까운 사람부터 보내도록 정렬 (3명이라 단순 교환 정렬)
  for (int i = 0; i < n; i++)
    for (int j = i + 1; j < n; j++)
      if (pd[j] < pd[i]) {
        long td = pd[i]; pd[i] = pd[j]; pd[j] = td;
        int16_t tx = px[i]; px[i] = px[j]; px[j] = tx;
        int16_t ty = py[i]; py[i] = py[j]; py[j] = ty;
      }

  // [RG] 안전 지연: 사람이 보이면 시각 기록, 사라져도 HOLD_MS 동안은 'X' 유지
  if (found) lastSeenMs = millis();
  bool stop = found || (millis() - lastSeenMs < HOLD_MS);

  // 상태 결정 (있으면 X, 없으면 A)
  char currentState = stop ? 'X' : 'A';

  // [최적화] 상태가 변했거나, 2초가 지났을 때만 블루투스로 전송
  if (currentState != lastState || millis() - lastSendTime > 2000) {
    if (connected) {
      SerialBT.print(currentState); // LED 패널로 전송
      Serial.print(currentState == 'X' ? "🚨 감지됨 -> 'X' 전송" : "✅ 안전함 -> 'A' 전송");
      Serial.println();
    }
    lastState = currentState;
    lastSendTime = millis();
  }

  // [RG] 보이는 사람 모두의 좌표를 한 줄로 100 ms 간격 전송 → LED 유닛이 메타버스로 넘김
  //      예) RG:POS,-320,1850,900,3400   (가까운 순, 한 사람당 x,y)
  if (found && connected && millis() - lastPosMs >= POS_MS) {
    lastPosMs = millis();
    SerialBT.print("RG:POS");
    for (int i = 0; i < n; i++) {
#if MIRROR_X
      px[i] = -px[i];
#endif
      SerialBT.printf(",%d,%d", px[i], py[i]);
    }
    SerialBT.print("\n");
  }
}

void loop() {
  // 1. 센서 데이터가 들어오면 계속 읽어서 분석
  while (Serial2.available()) {
    uint8_t b = Serial2.read();
    if (idx == 0 && b != 0xAA) continue;
    if (idx == 1 && b != 0xFF) { idx = 0; continue; }
    if (idx == 2 && b != 0x03) { idx = 0; continue; }
    if (idx == 3 && b != 0x00) { idx = 0; continue; }
    buf[idx++] = b;

    if (idx >= 30) {
      if (buf[28]==0x55 && buf[29]==0xCC) {
        parseFrame(buf);
      }
      idx = 0;
    }
  }

  // [RG] 블루투스가 도중에 끊겼는지 확인
  if (connected && !SerialBT.connected()) {
    connected = false;
    Serial.println("⚠️ LED ESP와 연결이 끊어졌습니다.");
  }

  // 2. 만약 연결이 끊겼거나 처음에 실패했다면, 5초마다 재연결 시도
  if (!connected && millis() - lastRetryMs > 5000) {
    Serial.println("재연결 시도 중...");
    connected = SerialBT.connect("RightGuard_LED");
    if (connected) { Serial.println("✅ 재연결 성공!"); lastState = ' '; }  // 연결되면 상태를 바로 다시 보냄
    lastRetryMs = millis();
  }
}
