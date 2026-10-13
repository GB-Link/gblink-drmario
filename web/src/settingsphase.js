import React from 'react';

class SettingsPhase extends React.Component {
  getMusicName(musicValue) {
    const musicMap = {
      '30': 'Fever',
      '31': 'Chill',
      '32': 'Off',
      0x30: 'Fever',
      0x31: 'Chill',
      0x32: 'Off'
    };
    return musicMap[musicValue] || 'Unknown';
  }

  getSpeedName(speedValue) {
    const speedMap = {
      0x22: 'HI',
      0x23: 'MED',
      0x24: 'LOW',
      34: 'HI',
      35: 'MED',
      36: 'LOW'
    };
    return speedMap[speedValue] || 'MED';
  }

  handleMusicSelect(music) {
    if(this.props.onMusicSelect) {
      this.props.onMusicSelect(music);
    }
  }

  handleStartGame() {
    if(this.props.onStartGame) {
      this.props.onStartGame();
    }
  }

  render() {
    const { phase, countdown, mySelection: myProp, opponentSelection: oppProp, admin } = this.props;
    const defaultSelection = { virus_level: 0, speed: 0x23, music: 0x30 };
    const mySelection = { ...defaultSelection, ...(myProp || {}) };
    const opponentSelection = { ...defaultSelection, ...(oppProp || {}) };
    const myLevel = Number(mySelection.virus_level);
    const oppLevel = Number(opponentSelection.virus_level);
    const myVirusCount = ((isNaN(myLevel) ? 0 : myLevel) + 1) * 4;
    const oppVirusCount = ((isNaN(oppLevel) ? 0 : oppLevel) + 1) * 4;

    return (
      <div>
        <h2>Game Settings</h2>

        <div className={`settings-section${phase === 'virus_level' ? ' settings-section-active' : ''}`}>
          <h3>
            Virus Level 
            {phase === 'virus_level' && countdown > 0 && ` (${countdown}s remaining)`}
          </h3>
          <p><strong>Your selection:</strong> Level {isNaN(myLevel) ? 0 : myLevel} ({myVirusCount} viruses)</p>
          <p><strong>Opponent:</strong> Level {isNaN(oppLevel) ? 0 : oppLevel} ({oppVirusCount} viruses)</p>
          {phase === 'virus_level' && (
            <p>Adjust virus level on your Game Boy</p>
          )}
        </div>

        <div className={`settings-section${phase === 'speed' ? ' settings-section-active' : ''}`}>
          <h3>
            Speed
            {phase === 'speed' && countdown > 0 && ` (${countdown}s remaining)`}
          </h3>
          <p><strong>Your selection:</strong> {this.getSpeedName(mySelection.speed ?? 0x23)}</p>
          <p><strong>Opponent:</strong> {this.getSpeedName(opponentSelection.speed ?? 0x23)}</p>
          {phase === 'speed' && (
            <p>Adjust speed on your Game Boy</p>
          )}
        </div>

        <div className={`settings-section${phase === 'music' ? ' settings-section-active' : ''}`}>
          <h3>Music</h3>
          {admin ? (
            <div>
              <p>Only the game creator can select music (applies to both players).</p>
              <div className="mb-2 music-button-row">
                <button 
                  className={`btn musicButton ${this.getMusicName(mySelection.music) === 'Fever' ? 'btn-secondary' : 'btn-outline-secondary'}`}
                  onClick={() => this.handleMusicSelect(0x30)}
                  disabled={phase !== 'music'}
                >
                  Fever
                </button>
                <button 
                  className={`btn musicButton ${this.getMusicName(mySelection.music) === 'Chill' ? 'btn-secondary' : 'btn-outline-secondary'}`}
                  onClick={() => this.handleMusicSelect(0x31)}
                  disabled={phase !== 'music'}
                >
                  Chill
                </button>
                <button 
                  className={`btn musicButton ${this.getMusicName(mySelection.music) === 'Off' ? 'btn-secondary' : 'btn-outline-secondary'}`}
                  onClick={() => this.handleMusicSelect(0x32)}
                  disabled={phase !== 'music'}
                >
                  Off
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p><strong>Selected Music:</strong> {this.getMusicName(mySelection.music)}</p>
              <p>Only the game creator can select music. They will choose from Fever, Chill, or Off.</p>
            </div>
          )}

        </div>

        {phase === 'music' && admin && (
          <button 
            className="btn btn-lg btn-secondary start-game-button"
            onClick={() => this.handleStartGame()}
          >
            Start Game
          </button>
        )}

        {phase === 'music' && !admin && (
          <p className="start-game-waiting">Waiting for admin to start game...</p>
        )}
      </div>
    );
  }
}

export { SettingsPhase };
