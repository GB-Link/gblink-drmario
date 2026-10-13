import React from 'react';

class SelectGame extends React.Component {
  generateName() {
    var prefixes = [
      "Black",
      "Gray",
      "White",
      "Red",
      "Blue",
      "Yellow"
    ]
    var suffixes = [
      "Virus",
      "Doctor",
      "Capsule",
      "Bottle",
      "Fever",
      "Chill"
    ]

    return prefixes[Math.floor(Math.random() * prefixes.length)] + " " + suffixes[Math.floor(Math.random() * suffixes.length)];
  }

  constructor(props) {
    super(props);
    this.state = {
      name: this.generateName(),
      game_code: "",
      selectionTime: 5
    };
  }

  handleNameChanged(event) {
    this.setState({
      name: event.target.value
    })
  }


  handleGameCodeChanged(event) {
    this.setState({
      game_code: event.target.value
    })
  }

  handleSelectionTimeChanged(event) {
    this.setState({
      selectionTime: Number(event.target.value)
    })
  }

  render() {
    return (

      <div className="connect">
        <h2>Select a username:</h2>
        <input type="text" className="form-control username-input" onChange={this.handleNameChanged.bind(this)} value={this.state.name} />
        <hr/>
        <div className="container">
          <div className="row">
            <div className="col-6">
              <div className="card custom-card">
                <div className="card-body">
                  <div className="card-title">
                    <h4>Create game</h4>
                  </div>
                  <div className="card-text">
                    <label className="selection-time-label" htmlFor="selection-time">
                      Time per setting: {this.state.selectionTime}s
                    </label>
                    <input
                      id="selection-time"
                      type="range"
                      className="form-range selection-time-slider"
                      min="3"
                      max="20"
                      step="1"
                      value={this.state.selectionTime}
                      onChange={this.handleSelectionTimeChanged.bind(this)}
                    />
                    <button onClick={() => this.props.onCreateGame(this.state.name, this.state.selectionTime)} className="btn btn-lg btn-secondary">Create</button>
                  </div>
                </div>
              </div>
            </div>
            <div className="col-6">
              <div className="card custom-card">
                <div className="card-body">
                  <div className="card-title">
                    <h4>Join game</h4>
                  </div>
                  <div className="card-text">
                  <input
                    type="text"
                    className="form-control game-code-input"
                    onChange={this.handleGameCodeChanged.bind(this)}
                    onKeyUp={(e) => e.key == 'Enter' ? this.props.onJoinGame(this.state.name, this.state.game_code): null}
                    value={this.state.game_code}
                    placeholder="ABCD" />
                  <button onClick={() => this.props.onJoinGame(this.state.name, this.state.game_code)} className="btn btn-lg btn-secondary">Join</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <hr />
      </div>
    )
  }
}

export { SelectGame };
