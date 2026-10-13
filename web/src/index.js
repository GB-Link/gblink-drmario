import React from 'react';
import { createRoot } from 'react-dom/client';

import 'bootstrap/dist/css/bootstrap.min.css';
import './index.css';

import { Serial } from './serial.js';
import { SerialWS } from './serial_ws.js';
import { GBWebsocket } from './gbwebsocket.js';
import { Lobby } from './lobby.js';
import { SelectGame } from './selectgame.js';
import { InGame } from './ingame.js';
import { SettingsPhase } from './settingsphase.js';

const IMG_BASE = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '') + '/images';


class OnlineDrMario extends React.Component {
  StateStart = "Start"; // splash screen, hit connect to begin
  StateConnect = "Connect"; // pick a username and create/join a game
  StateConnecting = "Connecting"; // opening the USB device
  StateJoiningGame = "JoiningGame"; // talking to the game server
  StateLobby = "Lobby"; // waiting for the other player
  StateSettings = "Settings"; // virus level / speed / music phase
  StateStartingGame = "StartingGame"; // running the GB init handshake
  StateInGame = "InGame"; // actually playing!
  StateFinished = "Finished"; // round is over
  StateError = "StateError";

  // Needs to be in sync with server
  USER_STATE_ALIVE = 0;
  USER_STATE_DEAD = 1;
  USER_STATE_WINNER = 2;

  constructor(props) {
    super(props);
    this.state = {
      state: this.StateStart,
      music: 0x30,
      name: "Foo",
      game_code: "",
      users: [],
      virus_count: 0,
      virus_level: 0,
      speed: 0x23,
      uuid: "",
      admin: false,
      gbConnected: false,
      errorMessage: "",
      currentMenu: 0,
      navigating: false,
      navigationQueue: [],
      settingsPhase: null,
      settingsCountdown: 0,
      playerSelections: {}
    };
    this.handshakeStarted = false;
    this._handshakeActive = false;
    this._serialCycleActive = false;
    this._gameEndReported = false;
    this._pendingBytes = [];
    this._gameEndSignal = null;
    this._awaitingGarbagePayloadFromGb = false;
    this.opponentSelectionRef = { current: { virus_level: 0, speed: 0x23, music: 0x30 } };
    this.mySelectionRef = { current: { virus_level: 0, speed: 0x23, music: 0x30 } };
    this.selectedMusicRef = { current: 0x30 };
    this.musicBlastRef = { current: 0 };
    this.syncIntervalId = null;
    this.virusCountRef = { current: 4 };
    this.opponentVirusCountRef = { current: 4 };
  }

  handleStartClick(kind = 'usb') {
    this.serial = (kind === 'serial') ? new SerialWS() : new Serial();
    this.setState({
      state: this.StateConnecting
    });
    this.serial.getDevice().then(() => {
      this.setState({
        state: this.StateConnect,
        gbConnected: true
      });
    }).catch(c => {
      this.setState({
        state: this.StateStart,
        errorMessage: `Failed to connect ${kind === 'serial' ? 'serial port' : 'USB device'}`
      });
    });
  }

  updateVirusCount(virus_count) {
    const count = Math.min(Math.max(0, virus_count), 84);
    this.virusCountRef.current = count;
    if (this.state.virus_count !== count) {
      this.setState({ virus_count: count });
    }
    if (this.gb) this.gb.sendVirusCount(count);
  }

  setUsersWinLoseState(weWon) {
    const myUuid = this.gb && this.gb.uuid;
    if (!myUuid || !Array.isArray(this.state.users)) return;
    const users = this.state.users.map((u) => ({
      ...u,
      state: u.uuid === myUuid
        ? (weWon ? this.USER_STATE_WINNER : this.USER_STATE_DEAD)
        : (weWon ? this.USER_STATE_DEAD : this.USER_STATE_WINNER)
    }));
    this.setState({ users });
  }

  startGameTimer() {
    if (this._handshakeActive) {
      this._serialCycleActive = false;
      this._pendingBytes = [];
      return;
    }
    const st = this.state.state;
    if (st !== this.StateInGame && st !== this.StateFinished) {
      this._serialCycleActive = false;
      return;
    }

    this._serialCycleActive = true;

    const oppHex = this.opponentVirusCountRef.current.toString(16).padStart(2, '0');
    const fallbackByte = (st === this.StateFinished && this._gameEndSignal) ? this._gameEndSignal : oppHex;
    const nextByte = this._pendingBytes.length > 0 ? this._pendingBytes.shift() : fallbackByte;
    this.serial.sendHex(nextByte).then(() => {
      return this.serial.read(64, 2000);
    }).then((result) => {
      this._serialCycleActive = false;
      if (this._handshakeActive) return;

      const data = result.data;
      const buf = data.buffer;
      const len = data.byteLength != null ? data.byteLength : (buf && buf.byteLength) || 0;
      const value = len > 0 ? (new Uint8Array(buf, data.byteOffset || 0, len))[0] : null;

      // Garbage on the link is 0xFE plus one byte; do this before the virus-count handling below.
      if (this._awaitingGarbagePayloadFromGb && value !== null && value !== undefined) {
        this._awaitingGarbagePayloadFromGb = false;
        if (this.gb) this.gb.sendLinkByte(value & 0xFF);
      } else if (value === 0xFE) {
        this._awaitingGarbagePayloadFromGb = true;
        if (this.gb) this.gb.sendLinkByte(0xFE);
      } else if (!this._gameEndReported) {
        if (value === 0xFD) { // fd indicates we lost
          this._gameEndReported = true;
          this.setState({ state: this.StateFinished });
          if (this.gb) this.gb.sendDead();
        } else if (value === 0xF8) { // f8 indicates we won (cleared all viruses)
          this._gameEndReported = true;
          this.setState({ state: this.StateFinished });
          if (this.gb) this.gb.sendWin();
        } else if (value !== null && value !== undefined && value >= 0x00 && value <= 0x54) {
          // anything <= 0x54 is just our current virus count
          if (value !== this.virusCountRef.current) {
            this.updateVirusCount(value);
          }
        }
      }

      setTimeout(() => this.startGameTimer(), 30);
    }).catch(() => {
      this._serialCycleActive = false;
      if (!this._handshakeActive && (st === this.StateInGame || st === this.StateFinished)) {
        setTimeout(() => this.startGameTimer(), 50);
      }
    });
  }

  attemptHandshakeForSettings() {
    if (!this.serial || !this.gb) {
      console.warn("No serial or gb, cannot perform handshake");
      return;
    }
    if (this.state.state === this.StateSettings) {
      return;
    }
    // 30 -> 60 is the master/slave handshake the GB does before settings.
    this.serial.sendHex("30");
    this.serial.readHex(1, 5000).then(result => {
      const r = (result && result.toUpperCase()) === "60";
      if (!r) {
        setTimeout(() => this.attemptHandshakeForSettings(), 100);
        return;
      }
      setTimeout(() => {
        this.serial.sendHex("00");
        this.serial.readHex(1, 5000).then(result2 => {
          const r2 = (result2 && result2.toUpperCase()) === "60";
          if (!r2) {
            setTimeout(() => this.attemptHandshakeForSettings(), 100);
            return;
          }
          this.serial.sendHex("00");
          this.serial.readHex(1, 5000).then(() => {
            this.gb.sendGbConnected();
          }).catch(() => {
            this.gb.sendGbConnected();
          });
        }).catch(() => {
          setTimeout(() => this.attemptHandshakeForSettings(), 100);
        });
      }, 30);
    }).catch(() => {
      setTimeout(() => this.attemptHandshakeForSettings(), 100);
    });
  }

  gbRequestHandshake(gb) {
    if (this.handshakeStarted) return;
    this.handshakeStarted = true;
    this.attemptHandshakeForSettings();
  }

  navigateToMenu(targetMenu) {
    if(this.state.navigating) {
      return;
    }
    const navByte = '80';

    let entryValue;
    if (targetMenu === 0) {
      entryValue = '00';
    } else if (targetMenu === 1) {
      entryValue = this.state.speed.toString(16).padStart(2, '0');
    } else if (targetMenu === 2) {
      entryValue = (this.state.music ?? 0x30).toString(16).padStart(2, '0');
    } else {
      entryValue = '00';
    }
    
    this.setState({
      navigating: true,
      navigationQueue: [entryValue, navByte, '19'],
      navigationTargetMenu: targetMenu
    });
  }

  parseGameBoyResponse(hexResponse, currentMenu) {
    const raw = (typeof hexResponse === 'string' ? hexResponse : String(hexResponse || '')).trim();
    const byteStr = raw.slice(0, 2);
    if (!byteStr) return;
    const value = parseInt(byteStr, 16);
    if (isNaN(value)) return;

    const menu = currentMenu ?? this.state.currentMenu;
    if (value >= 0x00 && value <= 0x14 && menu === 0) {
      this.mySelectionRef.current.virus_level = value;
      this.setState(prev => {
        if (prev.virus_level === value) return null;
        return { virus_level: value };
      }, () => {
        if (this.gb) this.gb.sendSettingsUpdate(this.state.virus_level, this.state.speed, this.state.music);
      });
    } else if (value >= 0x22 && value <= 0x24 && menu === 1) {
      this.mySelectionRef.current.speed = value;
      this.setState(prev => {
        if (prev.speed === value) return null;
        return { speed: value };
      }, () => {
        if (this.gb) this.gb.sendSettingsUpdate(this.state.virus_level, this.state.speed, this.state.music);
      });
    }
  }

  startSettingsPollingLoop() {
    const POLL_MS = 30;

    setTimeout(() => {
      if (this.state.state !== this.StateSettings) {
        this.startSettingsPollingLoop();
        return;
      }

      if (this.state.navigationQueue && this.state.navigationQueue.length > 0) {
        const queue = [...this.state.navigationQueue];
        const isSecondByte = queue.length === 2;
        const sendByte = queue.shift();
        this.setState({ navigationQueue: queue });
        if (queue.length === 0 && this.state.navigationTargetMenu !== null) {
          this.setState({
            currentMenu: this.state.navigationTargetMenu,
            navigating: false,
            navigationTargetMenu: null
          });
        }
        if (!isSecondByte) {
          this.serial.sendHex(sendByte);
          this.serial.readHex(1).then(() => {}).catch(() => {});
        }
        this.startSettingsPollingLoop();
        return;
      }

      const currentMenu = this.state.currentMenu;
      const opp = this.opponentSelectionRef.current;
      const opponentByte = currentMenu === 0
        ? (opp.virus_level ?? 0).toString(16).padStart(2, '0')
        : currentMenu === 1
          ? (opp.speed ?? 0x23).toString(16).padStart(2, '0')
          : currentMenu === 2
            ? (this.selectedMusicRef.current ?? 0x30).toString(16).padStart(2, '0')
            : '00';

      const doOneExchange = (remainingBlast) => {
        this.serial.sendHex(opponentByte);
        this.serial.readHex(1, 500).then(response => {
          if (!this.state.navigating) {
            this.parseGameBoyResponse(response, currentMenu);
          }
        }).catch(() => {}).finally(() => {
          if (remainingBlast > 1) {
            doOneExchange(remainingBlast - 1);
          } else {
            if (currentMenu === 2 && this.musicBlastRef.current > 0) {
              this.musicBlastRef.current--;
            }
            this.startSettingsPollingLoop();
          }
        });
      };

      const musicBlast = currentMenu === 2 && this.musicBlastRef.current > 0 ? 3 : 1;
      doOneExchange(musicBlast);
    }, POLL_MS);
  }

  handleCreateGame(name, selectionTime = 5) {
    this.setState({
      state: this.StateJoiningGame,
      admin: true,
      name: name
    })
    this.gb = GBWebsocket.initiateGame(name, selectionTime);
    this.setGbCallbacks();
  }

  handleJoinGame(name, game_code) {
    if (!game_code || game_code.length != 4) {
      console.error('not a valid input. must have length 4')
      return;
    }
    this.setState({
      state: this.StateJoiningGame,
      admin: false,
      name: name,
      game_code: game_code
    })
    this.gb = GBWebsocket.joinGame(name, game_code);
    this.setGbCallbacks();
  }

  setGbCallbacks() {
    this.gb.onconnected = this.gbConnected.bind(this);
    this.gb.oninfoupdate = this.gbInfoUpdate.bind(this);
    this.gb.onrequesthandshake = this.gbRequestHandshake.bind(this);
    this.gb.ongamestart = this.gbGameStart.bind(this);
    this.gb.onuserinfo = this.gbUserInfo.bind(this);
    this.gb.onstartsettings = this.gbStartSettings.bind(this);
    this.gb.onsettingssync = this.gbSettingsSync.bind(this);
    this.gb.onnavigate = this.gbNavigate.bind(this);
    this.gb.onmusicsync = this.gbMusicSync.bind(this);
    this.gb.onsettingstimer = this.gbSettingsTimer.bind(this);
    this.gb.onwin = this.gbWin.bind(this);
    this.gb.onlose = this.gbLose.bind(this);
    this.gb.onlinkbyte = this.gbLinkByte.bind(this);
    this.gb.onerror = this.gbError.bind(this);
  }

  gbConnected(gb) {
    this.handshakeStarted = false;
    this.setState({
      game_code: gb.game_name,
      users: gb.users,
      state: this.StateLobby
    });
  }

  gbGameStart(gb) {
    this._handshakeActive = true;
    this._gameEndReported = false;
    this._pendingBytes = [];
    this._gameEndSignal = null;
    this._awaitingGarbagePayloadFromGb = false;
    if (this.serial) this.serial.bufClear();

    const rngSequence = gb.rng_sequence && gb.rng_sequence.length > 0 ? gb.rng_sequence : null;
    const bottle = gb.bottle && gb.bottle.length > 0 ? gb.bottle : null;
    if (!rngSequence || !bottle) {
      console.error('Game start: missing server RNG data (rng_sequence or bottle). Server must send these.');
      this.setState({ state: this.StateError, errorMessage: 'Missing server RNG data' });
      return;
    }

    const virusLevel = Math.max(0, Number(this.state.virus_level) || 0);
    const initialVirusCount = (virusLevel + 1) * 4; // 4 viruses on level 0, 84 on level 20
    const oppVirusLevel = Math.max(0, Number(this.opponentSelectionRef.current.virus_level) || 0);
    const opponentInitialVirusCount = (oppVirusLevel + 1) * 4;
    const delay = 4;
    const readMs = 2000;
    const r = { last: null };

    if (this.syncIntervalId != null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    this.setState({ state: this.StateStartingGame });

    const fail = (err) => {
      console.error('Game init read error', err);
      this._handshakeActive = false;
      this.setState({
        state: this.StateError,
        errorMessage: `Game Boy init failed: ${(err && err.message) ? err.message : String(err)}`
      });
    };
    const sendThenRead = (hex, next, delayAfterSendMs = 0) => {
      const doRead = (retries = 0) => {
        this.serial.readHex(1, readMs).then((resp) => {
          r.last = (resp && String(resp).toUpperCase().trim()) || '';
          setTimeout(next, delay);
        }).catch((err) => {
          if (retries < 6) {
            setTimeout(() => doRead(retries + 1), 300);
          } else {
            fail(err);
          }
        });
      };
      this.serial.sendHex(hex).then(() => {
        if (delayAfterSendMs > 0) setTimeout(doRead, delayAfterSendMs);
        else doRead();
      }).catch(fail);
    };

    // step 1: pump 18s to get the GB into the link cable menu
    const step1 = () => {
      const firstReadDelay = this.isFirstGame() ? 0 : 100;
      sendThenRead('18', () => sendThenRead('18', step2), firstReadDelay);
    };

    // step 2: blast 99 until we hear 66 back, then drop the first RNG byte
    const MAX_ATTEMPTS = 50;
    const STEP2_DELAY = 80;
    let step2Attempts = 0;
    const step2 = () => {
      step2Attempts = 0;
      const waitFor66 = () => {
        if (r.last === '66') {
          const b = (rngSequence[0] != null ? rngSequence[0] : 0).toString(16).padStart(2, '0');
          sendThenRead(b, () => step3(1));
          return;
        }
        step2Attempts++;
        if (step2Attempts >= MAX_ATTEMPTS) {
          fail(new Error(`step 2: no 0x66 after ${MAX_ATTEMPTS} tries, last was 0x${r.last || '??'}`));
          return;
        }
        sendThenRead('99', waitFor66);
      };
      const startStep2 = () => sendThenRead('99', waitFor66);
      setTimeout(startStep2, STEP2_DELAY);
    };

    // step 3: stream the rest of the RNG sequence, then 33 -> 77 to flip phase
    const step3 = (idx) => {
      if (idx < rngSequence.length) {
        const b = (rngSequence[idx] != null ? rngSequence[idx] : 0).toString(16).padStart(2, '0');
        sendThenRead(b, () => step3(idx + 1));
        return;
      }
      sendThenRead('33', () => {
        if (r.last === '77') {
          sendThenRead('18', step4);
        } else if (r.last === 'D0') {
          step4();
        } else {
          step3(idx);
        }
      });
    };

    // step 4: bottle handshake (D0 / E0 / C0). Sometimes the GB is already
    // waiting on D0 so we have to send it first to unstick it.
    const step4_waitD0 = () => {
      if (r.last === 'D0') {
        sendThenRead('E0', step4_afterE0);
        return;
      }
      if (r.last && r.last !== '77') {
        // GB skipped ahead and is already echoing virus counts. catch up.
        const gbByte = parseInt(r.last, 16);
        if (!isNaN(gbByte) && gbByte >= 0x04 && gbByte <= 0x54 && gbByte % 4 === 0) {
          const v = opponentInitialVirusCount.toString(16).padStart(2, '0');
          sendThenRead(v, step7);
          return;
        }
      }
      sendThenRead('18', step4_waitD0);
    };
    const step4_afterE0 = () => {
      if (r.last === 'D0') {
        sendThenRead('C0', step4_afterC0);
        return;
      }
      sendThenRead('E0', step4_afterE0);
    };
    const step4_afterC0 = () => {
      if (r.last === 'C0') {
        const b = (bottle[0] != null ? bottle[0] : 0xFF).toString(16).padStart(2, '0');
        sendThenRead(b, () => step5(1));
        return;
      }
      sendThenRead('C0', step4_afterC0);
    };
    const step4 = step4_waitD0;

    // step 5: send the bottle layout, finish with FF
    const step5 = (idx) => {
      if (idx < bottle.length) {
        const b = (bottle[idx] != null ? bottle[idx] : 0xFF).toString(16).padStart(2, '0');
        sendThenRead(b, () => step5(idx + 1));
        return;
      }
      sendThenRead('FF', step6);
    };

    // step 6: wait for D1 / C1 then hand over the opponent's initial virus count
    const step6_waitD1 = () => {
      if (r.last === 'D1') {
        sendThenRead('C1', step6_afterC1);
        return;
      }
      sendThenRead('FF', step6_waitD1);
    };
    const step6_afterC1 = () => {
      const gbByte = parseInt(r.last, 16);
      if (!isNaN(gbByte) && gbByte >= 0x04 && gbByte <= 0x54 && gbByte % 4 === 0) {
        const v = opponentInitialVirusCount.toString(16).padStart(2, '0');
        sendThenRead(v, step7);
        return;
      }
      sendThenRead('00', step6_afterC1);
    };
    const step6 = step6_waitD1;

    // step 7: and go!
    const step7 = () => {
      this.virusCountRef.current = initialVirusCount;
      this.opponentVirusCountRef.current = opponentInitialVirusCount;
      if (this.state.users && this.state.users.length >= 2 && this.gb && this.gb.uuid) {
        const other = this.state.users.find((u) => u.uuid !== this.gb.uuid);
        if (other != null && typeof other.virus_count === 'number' && other.virus_count > 0) {
          this.opponentVirusCountRef.current = Math.min(Math.max(0, other.virus_count), 84);
        }
      }
      this._handshakeActive = false;
      this._gameEndReported = false;
      this.setState({
        state: this.StateInGame,
        virus_count: initialVirusCount
      }, () => {
        if (this.gb) this.gb.sendVirusCount(initialVirusCount);
        this.startGameTimer();
      });
    };

    // Between rounds the GB needs a bunch of E8s to tear down before we can
    // run step1 again. 17 seems to do it.
    const E8_COUNT = 17;
    const roundEndE8Step = (count) => {
      if (count >= E8_COUNT) {
        setTimeout(step1, delay);
        return;
      }
      const advance = () => setTimeout(() => roundEndE8Step(count + 1), 30);
      this.serial.sendHex('E8').then(() => {
        this.serial.readHex(1, readMs).then((resp) => {
          r.last = (resp && String(resp).toUpperCase().trim()) || '';
          advance();
        }).catch(() => advance());
      }).catch(fail);
    };

    const waitForSerialIdle = () => new Promise(resolve => {
      const check = () => {
        if (!this._serialCycleActive &&
            !this.serial.send_active &&
            this.serial.buffer.length === 0) {
          resolve();
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });
    waitForSerialIdle().then(() => {
      if (this.isFirstGame()) {
        setTimeout(step1, delay);
      } else {
        roundEndE8Step(0);
      }
    });
  }

  gbUserInfo(gb) {
    this.setState({
      uuid: gb.uuid
    })
  }

  gbInfoUpdate(gb) {
    const users = Array.isArray(gb.users) ? [...gb.users] : [];
    const me = this.gb && this.gb.uuid && users.find((u) => u.uuid === this.gb.uuid);
    const nextState = {
      game_code: gb.game_name,
      users
    };
    if (me != null && typeof me.virus_count === 'number') {
      const count = Math.min(Math.max(0, me.virus_count), 84);
      nextState.virus_count = count;
      this.virusCountRef.current = count;
    }
    this.setState(nextState);
    if (users.length >= 2 && this.gb && this.gb.uuid) {
      const other = users.find((u) => u.uuid !== this.gb.uuid);
      if (other != null && typeof other.virus_count === 'number' && other.virus_count > 0) {
        const oppCount = Math.min(Math.max(0, other.virus_count), 84);
        this.opponentVirusCountRef.current = oppCount;
      }
    }
    if (gb.users && gb.users.length === 2 && this.serial && this.gb && !this.handshakeStarted) {
      this.handshakeStarted = true;
      this.attemptHandshakeForSettings();
    }
  }

  gbStartSettings(gb, data) {
    const raw = this.state.music != null ? (typeof this.state.music === 'number' ? this.state.music : parseInt(this.state.music, 16)) : 0x30;
    const musicVal = (raw >= 0x30 && raw <= 0x32) ? raw : 0x30;
    this.mySelectionRef.current = {
      virus_level: this.state.virus_level,
      speed: this.state.speed,
      music: musicVal
    };
    this.selectedMusicRef.current = musicVal;
    this.setState({
      state: this.StateSettings,
      settingsPhase: data.phase,
      settingsCountdown: data.countdown,
      currentMenu: 0,
      music: musicVal
    });
    this.startSettingsPollingLoop();
    if (this.syncIntervalId != null) clearInterval(this.syncIntervalId);
    this.syncIntervalId = setInterval(() => {
      if (this.state.state !== this.StateSettings) {
        if (this.syncIntervalId != null) clearInterval(this.syncIntervalId);
        this.syncIntervalId = null;
        return;
      }
      if (this.gb) {
        const m = this.mySelectionRef.current;
        this.gb.sendSettingsUpdate(m.virus_level, m.speed, m.music);
      }
    }, 500);
  }

  gbSettingsSync(gb, data) {
    if (data.opponent_selection != null) {
      this.opponentSelectionRef.current = {
        virus_level: Number(data.opponent_selection.virus_level) || 0,
        speed: data.opponent_selection.speed ?? 0x23,
        music: data.opponent_selection.music ?? 0x30
      };
      this.setState({ playerSelections: data });
    }
  }

  gbNavigate(gb, data) {
    this.setState({
      settingsPhase: data.phase,
      settingsCountdown: data.countdown
    });
    this.navigateToMenu(data.target_menu);
  }

  gbMusicSync(gb, music) {
    const value = typeof music === 'number' ? music : parseInt(music, 16);
    this.selectedMusicRef.current = value;
    this.musicBlastRef.current = 8;
    this.setState({
      music: value.toString(16).padStart(2, '0')
    });
  }

  gbSettingsTimer(gb, data) {
    this.setState({
      settingsCountdown: data.countdown
    });
  }

  gbWin(gb) {
    // fd tells the GB the other player topped out. we win!
    this._gameEndSignal = 'FD';
    if (!this._handshakeActive) {
      this._pendingBytes.push('FD', 'FD');
    }
  }

  gbLose(gb) {
    // f8 tells the GB the other player cleared their bottle. we lost...
    this._gameEndSignal = 'F8';
    if (!this._handshakeActive) {
      this._pendingBytes.push('F8', 'F8');
    }
  }

  gbLinkByte(gb, byte) {
    if (this._handshakeActive) return;
    if (typeof byte !== 'number' || byte < 0 || byte > 0xFF) return;
    this._pendingBytes.push(byte.toString(16).padStart(2, '0').toUpperCase());
  }

  gbError(gb, error) {
    console.error("WebSocket error:", error);
    this.setState({
      state: this.StateError,
      errorMessage: "Failed to connect to game server. Please check your connection and try again."
    });
  }

  isFirstGame() {
    for (var u of this.state.users) {
      if (u.num_wins > 0) {
        return false;
      }
    }
    return true;
  }

  handleMusicSelect(music) {
    if(this.gb && this.state.admin) {
      this.selectedMusicRef.current = music;
      this.musicBlastRef.current = 8;
      this.gb.sendMusicSelect(music);
      this.setState({
        music: music.toString(16).padStart(2, '0')
      });
    }
  }

  handleStartGame() {
    if (!this.gb || !this.serial) {
      this.setState({
        state: this.StateError,
        errorMessage: 'No Game Boy or server connection.'
      });
      return;
    }
    if (this.state.admin) {
      if (this.syncIntervalId != null) {
        clearInterval(this.syncIntervalId);
        this.syncIntervalId = null;
      }
      this.gb.sendStart();
    }
    this.setState({ state: this.StateStartingGame });
  }

  render() {
    // Prefer WebUSB; fall back to WebSerial (Firefox 151+, or Chromium with WebUSB disabled).
    const transport = ('usb' in navigator) ? 'usb' : (('serial' in navigator) ? 'serial' : null);
    if (transport) {
      if (this.state.state === this.StateStart) {
        return (
          <div className="connect">
            <img src={`${IMG_BASE}/animation.gif`} className="gameboy hero-icon" alt="" />
            <h2 className="cover-heading">Dr. Mario Online</h2>
            <p className="lead">Connect your Game Boy, boot Dr. Mario, and start playing with your friends!</p>
            <hr />
            <h4>Connect your Game Boy</h4>
            <p>Connect your Game Boy with the USB to Game Link adapter and click "Connect".</p>
            <button
              onClick={(e) => this.handleStartClick(transport)}
              className="btn btn-lg btn-secondary">{transport === 'serial' ? 'Connect Serial' : 'Connect USB'}</button>
            <br/>
            <br/>
            <small>Version: 0.3.0</small>
          </div>
        )
      } else if (this.state.state === this.StateConnect) {
        return (
          <div className="connect">
            <div style={{ fontSize: '80px' }}>💊</div>
            <h2 className="cover-heading">Dr. Mario</h2>
            <p className="lead">Play Dr. Mario with your friends online!</p>
            <hr />
            <SelectGame onCreateGame={(name, selectionTime) => this.handleCreateGame(name, selectionTime)} onJoinGame={(name, code) => this.handleJoinGame(name, code)} />
            <br/>
            <small>Version: 0.3.0</small>
          </div>
        )
      } else if (this.state.state === this.StateConnecting) {
        return (
          <div className="connect">
            <h2>Connecting...</h2>
          </div>
        )

      } else if(this.state.state === this.StateJoiningGame) {
        return(<div className="connect">
          <h2>Connecting to game server...</h2>
        </div>)
      } else if(this.state.state === this.StateLobby) {
        return(<div className="connect">
          <Lobby
              game_code={this.state.game_code}
              users={this.state.users}
              admin={this.state.admin}
              uuid={this.state.uuid}/>
        </div>)
      } else if(this.state.state === this.StateSettings) {
        return(<div className="connect">
          <SettingsPhase
              phase={this.state.settingsPhase}
              countdown={this.state.settingsCountdown}
              mySelection={{ virus_level: this.state.virus_level, speed: this.state.speed, music: this.state.music }}
              opponentSelection={this.state.playerSelections?.opponent_selection ?? this.opponentSelectionRef.current}
              admin={this.state.admin}
              onMusicSelect={(music) => this.handleMusicSelect(music)}
              onStartGame={() => this.handleStartGame()}/>
        </div>)
      } else if(this.state.state === this.StateStartingGame) {
        return(<div className="connect">
          <h2>Starting game...</h2>
        </div>)

      } else if(this.state.state === this.StateInGame) {
        return(<div className="connect">

          <InGame game_code={this.state.game_code} users={this.state.users} admin={this.state.admin} currentUserUuid={this.state.uuid || (this.gb && this.gb.uuid)} />
        </div>)

      } else if(this.state.state === this.StateFinished) {
        return (<div className="connect">
            <InGame game_code={this.state.game_code} users={this.state.users} admin={this.state.admin} uuid={this.state.uuid} />
            <h2>Game finished!</h2>
            {this.state.admin ? (
              <button onClick={(e) => this.handleStartGame()} className="btn btn-lg btn-secondary">Start next game!</button>
            ) : (
              <p style={{ color: 'white' }}>Waiting for other player to start next game.</p>
            )}
          </div>)
      } else if(this.state.state === this.StateError) {
        return (
          <div className="connect">
            <h2>Error</h2>
            <h3>{this.state.errorMessage}</h3>
            <p>&nbsp;</p>
            <button onClick={(e) => this.setState({state: this.StateStart, errorMessage: ""})} className="btn btn-lg btn-secondary">
              Back to Start
            </button>
          </div>
        )
      } else {
        return (
          <div>Invalid state {this.state.state}</div>
        )
      }
    } else {
      return (
        <div>
          <h2>Sorry, your browser supports neither WebUSB nor WebSerial!</h2>
          <p>Use Chrome/Edge (WebUSB or WebSerial) or Firefox 151+ (WebSerial).</p>
        </div>
      )
    }
  }
}

const root = createRoot(document.getElementById('root'));
root.render(<OnlineDrMario />);
