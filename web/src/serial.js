
const fromHexString = hexString =>
  new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));



function buf2hex(buffer) { // buffer is an ArrayBuffer
  return [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
}

class Serial {
  constructor() {
    this.buffer = [];
    this.send_active = false;
  }

  static getPorts() {
    return navigator.usb.getDevices().then(devices => {
      return devices;
    });
  }

  static requestPort() {
    const filters = [
      { 'vendorId': 0x239A }, // Adafruit boards
      { 'vendorId': 0xcafe }, // TinyUSB example
    ];
    return navigator.usb.requestDevice({ 'filters': filters }).then(
      device => {
        return device;
      }
    );
  }

  getEndpoints(interfaces) {
    interfaces.forEach(element => {
      var alternates = element.alternates;
      alternates.forEach(elementalt => {
        if (elementalt.interfaceClass === 0xFF) {
          this.ifNum = element.interfaceNumber;
          elementalt.endpoints.forEach(elementendpoint => {
            if (elementendpoint.direction === "out") {
              this.epOut = elementendpoint.endpointNumber;
            }

            if (elementendpoint.direction === "in") {
              this.epIn = elementendpoint.endpointNumber;
            }
          });
        }
      })
    })
  }

  getDevice() {
    let device = null;
    this.ready = false;
    return new Promise((resolve, reject) => {
      Serial.requestPort().then(dev => {
        device = dev;
        this.device = device;
        return dev.open();
      }).then(() => {
        return device.selectConfiguration(1);
      }).then(() => {
        this.getEndpoints(device.configuration.interfaces);
      }).then(() => {
        return device.claimInterface(this.ifNum);
      }).then(() => {
        return device.selectAlternateInterface(this.ifNum, 0);
      }).then(() => {
        return device.controlTransferOut({
          'requestType': 'class',
          'recipient': 'interface',
          'request': 0x22,
          'value': 0x01,
          'index': this.ifNum
        })
      }).then(() => {
        this.ready = true;
        this.device = device;
        resolve();
      })
    });
  }

  read(num, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject('Cannot connect to GB Link Cable Adapter. Please reconnect it to the PC.');
      }, timeoutMs);
      this.device.transferIn(this.epIn, num).then(result => {
        clearTimeout(timeoutId);
        resolve(result);
      }).catch(error => {
        clearTimeout(timeoutId);
        console.error(error);
        reject(error);
      });
    });
  }

  readHex(num, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      this.read(num, timeoutMs).then(result => {
        resolve(buf2hex(result.data.buffer));
      }).catch(error => {
        reject(error);
      });
    });
  }

  readString() {
    this.device.transferIn(this.epIn, 64).then(result => {
      let textDecoder = new TextDecoder();
      return textDecoder.decode(result.data);
    },
      error => {
        console.error(error);
      })
  }

  sendString(str) {
    return this.send(new TextEncoder('utf-8').encode(str));
  }

  sendHex(str) {
    return this.send(fromHexString(str));
  }

  send(data) {
    return this.device.transferOut(this.epOut, data);
  }

  bufSendFunction() {
    this.send_active = true;
    if(this.buffer.length === 0) {
      this.send_active = false;
      return;
    }
    var element = this.buffer.shift();
    var data = element[0];
    var delay = element[1];
    this.send(data).then(() => {
      setTimeout(() => {
        this.bufSendFunction();
      }, delay);
    });
  }

  bufSend(data, delay) {
    this.buffer.push([data, delay]);
    // Sender is not active, create new one
    if(!this.send_active) {
      this.bufSendFunction();
    }
  }

  bufSendHex(str, delay) {
    var data = fromHexString(str);
    this.bufSend(data, delay);
  }

  bufClear() {
    this.buffer = [];
  }
}

export { Serial };
