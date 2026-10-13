const WEBSOCKET_HOST = import.meta.env.VITE_WEBSOCKET_HOST;
const WEBSOCKET_PORT = import.meta.env.VITE_WEBSOCKET_PORT;

const fromHexString = hexString =>
  new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));


class GBWebsocket {
  // Needs to be in sync with server!!!
  GAME_STATE_LOBBY = 0
  GAME_STATE_SETTINGS = 1
  GAME_STATE_RUNNING = 2
  GAME_STATE_BETWEEN = 3
  GAME_STATE_FINISHED = 4
  GAME_STATE_ERROR = 9998
  GAME_STATE_NONE = 9999

  constructor(url, name, selectionTime = null) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (function(event) {
      this.onMessage(event);
    }).bind(this); // required to this points to GBWebsocket, not the websocket instance.
    
    this.ws.onerror = (function(error) {
      console.error("WebSocket error:", error);
      this.onerror(this, error);
    }).bind(this);
    
    this.ws.onclose = (function(event) {
      this.onclose(this, event);
    }).bind(this);

    this.onconnected = function() {}
    
    this.onerror = function() {}
    
    this.onclose = function() {}

    this.oninfoupdate = function() {}
    this.ongamestart = function() {}

    this.ongameupdate = function() {}

    this.ongameend = function() {}

    this.onuserinfo = function() {}

    this.onstartsettings = function() {}

    this.onsettingssync = function() {}

    this.onnavigate = function() {}

    this.onmusicsync = function() {}

    this.onsettingstimer = function() {}

    this.onwin = function() {}

    this.onlose = function() {}

    this.onlinkbyte = function() {}

    this.onrequesthandshake = function() {}

    this.admin = false;
    this.name = name;
    this.selectionTime = selectionTime;
    this.game_name = "YOU SHOULD NEVER SEE THIS"; // famous last words
    this.game_status = this.GAME_STATE_NONE;
    this.users = []
    this.uuid = ""
    this.waitForConnection();
  }

  sendRegisterMessage() {
    var msg = {
      "type": "register",
      "name": this.name
    };
    if (this.selectionTime != null) {
      msg.selection_time = this.selectionTime;
    }
    this.ws.send(JSON.stringify(msg));
  }

  getOtherUsers() {
    var res = this.users.filter(u => u.uuid != this.uuid);
    return res;
  }

  waitForConnection() {
    if(this.ws.readyState === 1) {
      this.sendRegisterMessage();
      this.onconnected(this);
    } else {
      setTimeout(
        this.waitForConnection.bind(this),
        100
      );
    }
  }

  sendVirusCount(virus_count) {
    this.ws.send(JSON.stringify({
      "type": "virus_update",
      "virus_count": virus_count
    }));
  }

  sendStartSettings() {
    this.ws.send(JSON.stringify({
      "type": "start_settings"
    }))
  }

  sendSettingsUpdate(virus_level, speed, music) {
    this.ws.send(JSON.stringify({
      "type": "settings_update",
      "virus_level": virus_level,
      "speed": speed,
      "music": music
    }));
  }

  sendMusicSelect(music) {
    this.ws.send(JSON.stringify({
      "type": "music_select",
      "music": music
    }));
  }

  sendStart() {
    this.ws.send(JSON.stringify({
      "type": "start"
    }))
  }

  sendDead() {
    this.ws.send(JSON.stringify({
      "type": "dead"
    }))
  }

  sendWin() {
    this.ws.send(JSON.stringify({
      "type": "win"
    }))
  }

  sendLinkByte(byte) {
    this.ws.send(JSON.stringify({
      "type": "link_byte",
      "byte": byte
    }));
  }

  sendGbConnected() {
    this.ws.send(JSON.stringify({
      "type": "gb_connected"
    }));
  }

  static initiateGame(name, selectionTime = 5) {
    const protocol = WEBSOCKET_HOST === 'localhost' ? 'ws' : 'wss';
    var gb = new GBWebsocket(`${protocol}://${WEBSOCKET_HOST}:${WEBSOCKET_PORT}/create`, name, selectionTime);
    gb.admin = true;
    return gb;
  }

  static joinGame(name, code) {
    const protocol = WEBSOCKET_HOST === 'localhost' ? 'ws' : 'wss';
    return new GBWebsocket(`${protocol}://${WEBSOCKET_HOST}:${WEBSOCKET_PORT}/join/` + code, name)
  }

  onMessage(event) {
    var message = JSON.parse(event.data);

    switch(message.type) {
      case "game_info":
        this.game_name = message.name;
        this.game_status = message.status ?? message.state;
        this.users = message.users;
        this.oninfoupdate(this);
        break;
      case "request_handshake":
        this.onrequesthandshake(this);
        break;
      case "user_info":
        this.uuid = message.uuid;
        this.onuserinfo(this);
        break;
      case "start_settings":
        this.onstartsettings(this, message);
        break;
      case "settings_sync":
        this.onsettingssync(this, message);
        break;
      case "settings_timer":
        this.onsettingstimer(this, message);
        break;
      case "navigate_menu":
        this.onnavigate(this, message);
        break;
      case "music_sync":
        this.onmusicsync(this, message.music);
        break;
      case "bottle":
        this.bottle = fromHexString(String(message.bottle));
        break;
      case "start_game":
        this.rng_sequence = fromHexString(String(message.rng_sequence));
        this.ongamestart(this);
        break;
      case "game_update":
        this.ongameupdate(this);
        break;
      case "error":
        this.state = this.GAME_STATE_ERROR;
        this.ongameupdate(this);
        break;
      case "end":
        this.state = this.GAME_STATE_FINISHED;
        this.ongameend(this);
        break;
      case "win":
        this.onwin(this);
        break;
      case "lose":
        this.onlose(this);
        break;
      case "link_byte":
        if (typeof message.byte === "number") {
          this.onlinkbyte(this, message.byte);
        }
        break;
      default:
        console.warn("Unknown message type:", message?.type);
        break;
    }
  }
}

export { GBWebsocket };
