import React from 'react';

const IMG_BASE = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '') + '/images';

class Player extends React.Component {
  // Needs to be in sync with server
  STATE_ALIVE = 0
  STATE_DEAD = 1
  STATE_WINNER = 2
  render() {
    const isCurrentUser = this.props.currentUserUuid != null && this.props.user.uuid === this.props.currentUserUuid;
    const displayName = isCurrentUser ? `${this.props.user.name} (You)` : this.props.user.name;
    let imageName = 'animation.gif';
    let statusLine = `Virus Total: ${this.props.user.virus_count}`;

    if (this.props.user.state === this.STATE_DEAD) {
      imageName = 'dead.png';
      statusLine = 'Game Over';
    } else if (this.props.user.state === this.STATE_WINNER) {
      imageName = 'win.png';
      statusLine = 'Winner!!!';
    }

    return (
      <div className="col-3 player-card">
        <img src={IMG_BASE + `/${imageName}`} className="gameboy" />
        <p className="player-card-text">
          <b>{displayName}</b>
          <br/>
          {statusLine}
          <br/>
          Wins: {this.props.user.num_wins}
        </p>
      </div>
    )
  }
}

export { Player };
