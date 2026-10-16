import React from 'react';

import {Player} from './player.js';

class InGame extends React.Component {
  render() {
    const currentUserUuid = this.props.currentUserUuid || this.props.uuid;
    const sortedUsers = [...(this.props.users || [])].sort((a, b) => {
      const aIsMe = a.uuid === currentUserUuid;
      const bIsMe = b.uuid === currentUserUuid;
      if (aIsMe === bIsMe) return 0;
      return aIsMe ? -1 : 1;
    });

    return (
      <div>
        <h2>In Game: {this.props.isMatchmaking ? 'Matchmaking' : this.props.game_code}</h2>
        <div className="container">
          <div className="row justify-content-center players-row">
              {sortedUsers.map((user) => (
                <Player
                  key={user.uuid || user.name}
                  user={user}
                  currentUserUuid={currentUserUuid}
                />
              ))}
          </div>
        </div>
      </div>
    )
  }
}

export { InGame };
