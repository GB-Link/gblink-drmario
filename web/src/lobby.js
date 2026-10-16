import React from 'react';

import {Player} from './player.js';

const WAITING_ELLIPSIS = ['.', '..', '...'];

class Lobby extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      copied: false,
      ellipsisIndex: 0
    }
  }

  componentDidMount() {
    this.ellipsisInterval = setInterval(() => {
      this.setState(prev => ({
        ellipsisIndex: (prev.ellipsisIndex + 1) % WAITING_ELLIPSIS.length
      }));
    }, 500);
  }

  componentWillUnmount() {
    if (this.ellipsisInterval) {
      clearInterval(this.ellipsisInterval);
    }
  }

  handleCopyCode() {
    navigator.clipboard.writeText(this.props.game_code).then(() => {
      this.setState({ copied: true });
      setTimeout(() => {
        this.setState({ copied: false });
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy: ', err);
    });
  }

  render() {
    var userbar;
    const hasOpponent = this.props.users && this.props.users.length >= 2;
    const sortedUsers = [...(this.props.users || [])].sort((a, b) => {
      const aIsMe = a.uuid === this.props.uuid;
      const bIsMe = b.uuid === this.props.uuid;
      if (aIsMe === bIsMe) return 0;
      return aIsMe ? -1 : 1;
    });

    if (!hasOpponent) {
      userbar = (
        <div>
          <p>Waiting for other player to join{WAITING_ELLIPSIS[this.state.ellipsisIndex]}</p>
          <p>Ensure your Game Boy is turned on and in the Dr. Mario main menu.</p>
        </div>
      );
    } else {
      const opponentConnected = this.props.users.length >= 2 && this.props.users.find(u => u.uuid !== this.props.uuid)?.gb_connected;
      if(!opponentConnected) {
        userbar = <p>Waiting for opponent to connect their Game Boy...</p>
      } else {
        userbar = <p>Both players ready! Settings phase will start automatically...</p>
      }
    }

    const displayCode = this.props.isMatchmaking ? 'Matchmaking' : this.props.game_code;
    const canCopy = !this.props.isMatchmaking;

    return (
      <div>
        <h2>
          In Lobby:{' '}
          {canCopy ? (
            <span 
              onClick={() => this.handleCopyCode()} 
              style={{ cursor: 'pointer', textDecoration: 'underline' }}
              title="Click to copy"
            >
              {displayCode}
            </span>
          ) : (
            <span>{displayCode}</span>
          )}
        </h2>
        {this.state.copied && <p>Copied to clipboard!</p>}
        <h4>Players:</h4>
        <div className="container">
          <div className="row justify-content-center">
              {sortedUsers.map((user) => (
                <Player key={`lobby-${user.uuid}`} user={user} currentUserUuid={this.props.uuid} />
            ))}
          </div>
        </div>
        {userbar}
      </div>
    )
  }
}

export { Lobby };
