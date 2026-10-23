// 실제 Right Guard 장치 연결 (Web Serial, USB)
// 메타버스 → 장치 : RG:HELLO / RG:STOP / RG:GO / RG:MODE,MIX|META|REAL  (115200 baud, 줄바꿈 구분)
// 장치 → 메타버스 : RG:HELLO,LED,<ver> / RG:LED,X|ARROW|OFF / RG:REAL,1|0 / RG:POS,<x_mm>,<y_mm> / RG:MODE,<m>
export class DeviceLink {
  constructor() {
    this.supported = typeof navigator !== 'undefined' && 'serial' in navigator;
    let policy = true;
    try {
      if (document.featurePolicy && document.featurePolicy.allowsFeature) policy = document.featurePolicy.allowsFeature('serial');
    } catch (e) { /* ignore */ }
    this.policyOK = policy;
    this.conns = [];
    this.realLed = null; // 장치가 보고한 LED 상태
    this.realLedT = -99;
    this.realDetected = false;
    this.realExplicit = false; // RG:REAL 줄을 받은 적 있음
    this.realT = -99;
    this.realPos = null;
    this.realTargets = []; // RG:POS 로 받은 사람들 (mm, 가까운 순, 최대 3명)
    this.realPosT = -99;
    this.metaState = 'GO';
    this.mode = 'MIX';
    this.deviceMode = null;
    this.twinOn = true;
    this.mirror = false;
    this.lastTx = -99;
    this.metaChangeT = -99;
    this.log = [];
    this.listeners = new Set();
    this.now = () => performance.now() / 1000;
    this.rxCount = 0;
    this.txCount = 0;
    this.lastRxT = -99;
    if (this.supported) {
      navigator.serial.addEventListener('disconnect', (e) => {
        const c = this.conns.find((k) => k.port === e.target);
        if (c) this._drop(c, '장치 연결이 끊어졌습니다 (케이블을 확인하세요)');
      });
    }
  }

  get connected() {
    return this.conns.length > 0;
  }
  get alive() {
    return this.connected && this.now() - this.lastRxT < 4;
  }
  get roleText() {
    if (!this.connected) return '';
    return this.conns.map((c) => c.role || '장치').join(' + ');
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit(type, data) {
    for (const fn of this.listeners) fn(type, data);
  }
  _log(dir, text) {
    this.log.push({ dir, text, t: this.now() });
    if (this.log.length > 80) this.log.shift();
    this._emit('log', { dir, text });
  }

  async connect() {
    if (!this.supported) throw new Error('UNSUPPORTED');
    if (!this.policyOK) throw new Error('BLOCKED');
    let port;
    try {
      port = await navigator.serial.requestPort({});
    } catch (e) {
      if (e && e.name === 'SecurityError') throw new Error('BLOCKED');
      throw new Error('CANCELLED');
    }
    if (this.conns.some((c) => c.port === port)) return;
    try {
      await port.open({ baudRate: 115200, bufferSize: 4096 });
    } catch (e) {
      throw new Error('BUSY');
    }
    // ESP32 자동 리셋 회로가 부팅 모드로 묶이지 않도록 신호선 해제
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch (e) { /* ignore */ }
    const conn = { port, role: null, writer: port.writable.getWriter(), reader: null, alive: true, hello: false };
    this.conns.push(conn);
    this._log('sys', '포트 열림 · 115200 baud');
    this._emit('status');
    this._readLoop(conn);
    // 부팅 대기 후 인사 (응답 올 때까지 몇 번 반복)
    let tries = 0;
    const greet = async () => {
      if (!conn.alive) return;
      if (!conn.hello) await this._write(conn, 'RG:HELLO');
      await this._sync(conn);
      if (!conn.hello && tries++ < 6) setTimeout(greet, 1500);
    };
    setTimeout(greet, 900);
  }

  async disconnect() {
    for (const c of [...this.conns]) await this._drop(c, '연결 해제');
  }

  async _drop(conn, msg) {
    if (!conn.alive) return;
    conn.alive = false;
    this.conns = this.conns.filter((c) => c !== conn);
    try { if (conn.reader) await conn.reader.cancel(); } catch (e) { /* ignore */ }
    try { conn.writer.releaseLock(); } catch (e) { /* ignore */ }
    try { await conn.port.close(); } catch (e) { /* ignore */ }
    if (!this.connected) {
      this.realDetected = false;
      this.realLed = null;
    }
    this._log('sys', msg);
    this._emit('status');
  }

  async _readLoop(conn) {
    const dec = new TextDecoder();
    let buf = '';
    while (conn.alive && conn.port.readable) {
      const reader = conn.port.readable.getReader();
      conn.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.search(/\r?\n/)) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1));
            if (line) this._handle(line, conn);
          }
          if (buf.length > 4000) buf = buf.slice(-400);
        }
      } catch (e) {
        // 일시적 오류(버퍼 초과 등)는 다시 읽기
      } finally {
        try { reader.releaseLock(); } catch (e) { /* ignore */ }
      }
      if (!conn.alive) break;
      await new Promise((r) => setTimeout(r, 50));
      if (!conn.port.readable) break;
    }
    if (conn.alive) this._drop(conn, '읽기 종료');
  }

  _handle(line, conn) {
    this.rxCount++;
    this.lastRxT = this.now();
    const t = this.now();
    const up = line.toUpperCase();
    let m;
    // 1초마다 오는 상태 재전송(하트비트)은 값이 바뀔 때만 기록
    if (up.startsWith('RG:')) {
      const k = up.split(',')[0];
      if (this._lastRx === undefined) this._lastRx = {};
      if (k === 'RG:POS') {
        if (!this._posLogT || t - this._posLogT > 2) { this._log('rx', line + ' …'); this._posLogT = t; }
      } else if (this._lastRx[k] !== up || k === 'RG:HELLO') this._log('rx', line);
      this._lastRx[k] = up;
    }
    if ((m = up.match(/^RG:HELLO,?([A-Z]*)/))) {
      conn.hello = true;
      if (m[1]) conn.role = m[1] === 'LED' ? 'LED 유닛' : m[1] === 'SENSOR' ? '센서 유닛' : m[1];
      this._sync(conn); // 장치가 (재)부팅했으면 모드와 현재 판단을 다시 알려 줌
      this._emit('status');
      return;
    }
    if ((m = up.match(/^RG:LED,(X|ARROW|OFF|STOP|GO)/))) {
      const v = m[1] === 'STOP' ? 'X' : m[1] === 'GO' ? 'ARROW' : m[1];
      this.realLed = v;
      this.realLedT = t;
      if (!conn.role) conn.role = 'LED 유닛';
      this._emit('led', v);
      return;
    }
    if ((m = up.match(/^RG:REAL,([01])/))) {
      this.realExplicit = true;
      this.realDetected = m[1] === '1';
      this.realT = t;
      this._emit('real', this.realDetected);
      return;
    }
    if ((m = up.match(/^RG:POS,(-?\d+),(-?\d+)/))) {
      // RG:POS,x1,y1[,x2,y2[,x3,y3]] — 레이더가 보는 사람 모두 (가까운 순). 첫 쌍이 가장 가까운 사람
      const nums = up.slice(7).split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
      const list = [];
      for (let i = 0; i + 1 < nums.length && list.length < 3; i += 2) list.push({ x: nums[i], y: nums[i + 1] });
      this.realTargets = list.length ? list : [{ x: +m[1], y: +m[2] }];
      this.realPos = this.realTargets[0];
      this.realPosT = t;
      if (!this.realExplicit) { this.realDetected = true; this.realT = t; }
      return;
    }
    if ((m = up.match(/^RG:MODE,(\w+)/))) {
      this.deviceMode = m[1];
      this._emit('status');
      return;
    }
    if (up.startsWith('RG:')) return;
    // 기존 디버그 출력도 최대한 이해하기: "X: 120 Y: 850" 같은 형식
    const xm = line.match(/\bx\s*[:=]\s*(-?\d+(?:\.\d+)?)/i), ym = line.match(/\by\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
    if (xm && ym) {
      let x = +xm[1], y = +ym[1];
      if (Math.abs(y) < 20 && Math.abs(x) < 20) { x *= 1000; y *= 1000; } // m 단위로 보이면 mm로
      if (y > 0) {
        this.realPos = { x, y };
        this.realTargets = [this.realPos];
        this.realPosT = t;
        if (!this.realExplicit) { this.realDetected = true; this.realT = t; }
      }
      this._log('rx', line);
      return;
    }
    if (this.log.length < 3 || Math.random() < 0.2) this._log('raw', line);
  }

  async _sync(conn) {
    await this._write(conn, 'RG:MODE,' + this.mode);
    await this._write(conn, this.metaState === 'STOP' ? 'RG:STOP' : 'RG:GO');
  }

  async _write(conn, text) {
    try {
      await conn.writer.write(new TextEncoder().encode(text + '\n'));
      this.txCount++;
      return true;
    } catch (e) {
      this._drop(conn, '쓰기 실패');
      return false;
    }
  }

  async send(text, { log = true } = {}) {
    if (!this.connected) return;
    for (const c of [...this.conns]) await this._write(c, text);
    if (log) this._log('tx', text);
  }

  setMeta(state) {
    if (state === this.metaState) return;
    this.metaState = state;
    this.lastTx = this.now();
    this.metaChangeT = this.lastTx;
    this.send(state === 'STOP' ? 'RG:STOP' : 'RG:GO');
    this._emit('meta', state);
  }

  setMode(mode) {
    this.mode = mode;
    this.send('RG:MODE,' + mode);
    this._emit('status');
  }

  // 매 프레임: 1초마다 상태 재전송(하트비트), 오래된 값 정리
  tick() {
    const t = this.now();
    if (this.connected && t - this.lastTx > 1.0) {
      this.lastTx = t;
      this.send(this.metaState === 'STOP' ? 'RG:STOP' : 'RG:GO', { log: false });
    }
    // REAL 보고 없이 좌표만 오는 경우: 1.5초간 좌표가 없으면 해제
    if (!this.realExplicit && this.realDetected && t - this.realPosT > 1.5) this.realDetected = false;
    // REAL 보고가 오래 끊기면 해제
    if (this.realExplicit && this.realDetected && t - this.realT > 6) this.realDetected = false;
    // REAL 줄이 없고 LED만 보고될 때: 메타버스가 GO인데 장치가 X면 현실 감지로 추정
    if (!this.realExplicit && this.realLed === 'X' && this.metaState === 'GO' && t - this.metaChangeT > 0.8 && t - this.realLedT < 3) {
      this.realDetected = true;
      this.realT = t;
      this.realInferred = true;
    } else if (this.realInferred && (this.realLed !== 'X' || this.metaState === 'STOP')) {
      this.realInferred = false;
      if (!this.realExplicit && t - this.realPosT > 1.5) this.realDetected = false;
    }
  }
}
