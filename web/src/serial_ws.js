/**
 * WebSerial backend with the same public API as Serial (./serial.js).
 *
 * Frame format (matches GBLink firmware SerialLayer):
 *   | 0x47 0x42 | channel:1 | len:2 LE | payload[len] |
 *     sync 'GB'   0=cmd,1=data,2=status
 */

const SYNC0 = 0x47;
const SYNC1 = 0x42;
const CH_CMD = 0x00;
const CH_DATA = 0x01;
const MAX_PAYLOAD = 64;

const GBL_CMD = {
  SET_MODE: 0x00,
  CANCEL: 0x01,
  SET_VOLTAGE_3V3: 0x40,
  SET_VOLTAGE_5V: 0x41,
  SET_LED_COLOR: 0x42,
};

const GBL_MODE = {
  GBA_TRADE_EMU: 0x00,
  GBA_LINK: 0x01,
  GB_LINK: 0x02,
};

class SerialWS {
  constructor() {
    this.buffer = [];
    this.send_active = false;
    this.isNewFirmware = true;
    this.ready = false;

    this.port = null;
    this.reader = null;
    this.writer = null;

    this._dataQueue = [];
    this._dataWaiters = [];

    this._rxState = 'sync1';
    this._rxChannel = 0;
    this._rxLen = 0;
    this._rxBuf = null;
    this._rxPos = 0;
  }

  static requestPort() {
    return navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x2FE3 }]
    });
  }

  async getDevice() {
    this.ready = false;
    this.port = await SerialWS.requestPort();
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this._runReadLoop();

    // GB Link mode + 5V for Game Boy hardware
    await this._sendCommand(new Uint8Array([GBL_CMD.SET_MODE, GBL_MODE.GB_LINK]));
    await this._sendCommand(new Uint8Array([GBL_CMD.SET_VOLTAGE_5V]));
    await new Promise(r => setTimeout(r, 500));

    this.ready = true;
  }

  async _runReadLoop() {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        for (let i = 0; i < value.length; i++) this._feedByte(value[i]);
      }
    } catch (e) {
      if (this.ready) console.warn('Read loop error:', e);
    }
  }

  _feedByte(b) {
    switch (this._rxState) {
      case 'sync1':
        if (b === SYNC0) this._rxState = 'sync2';
        break;
      case 'sync2':
        if (b === SYNC1) this._rxState = 'channel';
        else if (b === SYNC0) this._rxState = 'sync2';
        else this._rxState = 'sync1';
        break;
      case 'channel':
        this._rxChannel = b;
        this._rxState = 'lenLo';
        break;
      case 'lenLo':
        this._rxLen = b;
        this._rxState = 'lenHi';
        break;
      case 'lenHi':
        this._rxLen |= b << 8;
        if (this._rxLen > MAX_PAYLOAD) { this._rxState = 'sync1'; break; }
        this._rxPos = 0;
        this._rxBuf = new Uint8Array(this._rxLen);
        if (this._rxLen === 0) {
          this._dispatchFrame();
          this._rxState = 'sync1';
        } else {
          this._rxState = 'payload';
        }
        break;
      case 'payload':
        this._rxBuf[this._rxPos++] = b;
        if (this._rxPos >= this._rxLen) {
          this._dispatchFrame();
          this._rxState = 'sync1';
        }
        break;
    }
  }

  _dispatchFrame() {
    if (this._rxChannel !== CH_DATA) return;
    const frame = this._rxBuf;
    const waiter = this._dataWaiters.shift();
    if (waiter) waiter.resolve(frame);
    else this._dataQueue.push(frame);
  }

  async _writeFrame(channel, payload) {
    if (!this.writer) throw new Error('Not connected');
    if (payload.length > MAX_PAYLOAD) throw new Error('Payload too large');
    const frame = new Uint8Array(5 + payload.length);
    frame[0] = SYNC0;
    frame[1] = SYNC1;
    frame[2] = channel;
    frame[3] = payload.length & 0xFF;
    frame[4] = (payload.length >> 8) & 0xFF;
    frame.set(payload, 5);
    await this.writer.write(frame);
  }

  async _sendCommand(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    await this._writeFrame(CH_CMD, buf);
  }

  _awaitData(timeoutMs) {
    if (this._dataQueue.length > 0) return Promise.resolve(this._dataQueue.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this._dataWaiters.push(waiter);
      if (timeoutMs > 0) {
        setTimeout(() => {
          const idx = this._dataWaiters.indexOf(waiter);
          if (idx !== -1) {
            this._dataWaiters.splice(idx, 1);
            reject('Cannot connect to GB Link Cable Adapter. Please reconnect it to the PC.');
          }
        }, timeoutMs);
      }
    });
  }

  async setLed(r, g, b, on = true) {
    if (!this.ready) return false;
    await this._sendCommand(new Uint8Array([GBL_CMD.SET_LED_COLOR, r, g, b, on ? 1 : 0]));
    return true;
  }

  // Returns WebUSB-shaped {data: DataView} so existing callers using
  // result.data.buffer / result.data.byteLength keep working unchanged.
  async read(num, timeoutMs = 2000) {
    const frame = await this._awaitData(timeoutMs);
    return { data: new DataView(frame.buffer, frame.byteOffset, frame.byteLength) };
  }

  readHex(num, timeoutMs = 2000) {
    return this.read(num, timeoutMs).then(result => {
      const bytes = new Uint8Array(
        result.data.buffer, result.data.byteOffset, result.data.byteLength
      );
      return [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
    });
  }

  readString() {
    return this.read(64).then(result => new TextDecoder().decode(result.data));
  }

  sendString(str) {
    return this.send(new TextEncoder('utf-8').encode(str));
  }

  sendHex(str) {
    const data = new Uint8Array(str.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    return this.send(data);
  }

  send(data) {
    return this._writeFrame(CH_DATA, data);
  }

  bufSendFunction() {
    this.send_active = true;
    if (this.buffer.length === 0) {
      this.send_active = false;
      return;
    }
    const element = this.buffer.shift();
    const data = element[0];
    const delay = element[1];
    this.send(data).then(() => {
      setTimeout(() => this.bufSendFunction(), delay);
    });
  }

  bufSend(data, delay) {
    this.buffer.push([data, delay]);
    if (!this.send_active) this.bufSendFunction();
  }

  bufSendHex(str, delay) {
    const data = new Uint8Array(str.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    this.bufSend(data, delay);
  }

  bufClear() {
    this.buffer = [];
    this.send_active = false;
  }
}

export { SerialWS };
