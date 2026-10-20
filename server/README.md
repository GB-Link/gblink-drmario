# GB-DrMario-Server

The server part of the online Dr. Mario project. Python WebSocket coordinator for two browser clients (each with a Game Boy over USB).

The design follows [gb-tetris-server](https://github.com/classictoni/gb-tetris-server/); this fork handles Dr. Mario–specific lobby flow, settings sync, bottle/RNG generation, and link-byte forwarding.

## Build and run

```
pipenv install
pipenv run python server.py
```

Copy `template.env` to `.env` and configure:

| Variable | Description |
|----------|-------------|
| `WEBSOCKET_PORT` | Port for the WebSocket listener |
| `USE_SSL` | Set to `true` for TLS on the socket (`FULLCHAIN_CERT_PATH` and `PRIVKEY_PATH` required) |
| `FULLCHAIN_CERT_PATH` | TLS certificate chain (when using SSL) |
| `PRIVKEY_PATH` | TLS private key (when using SSL) |
| `REPORT_TOKEN` | Shared secret for status reports (`get_report`). Prefer path `/report` (HTTP 404 before handshake if token unset). If a proxy strips the path, `get_report` on `/` is still honored only when `REPORT_TOKEN` is set and the token matches. |

If `USE_SSL` is unset or not `true`, the server listens with plain `ws` on `0.0.0.0`.

Clients connect with path `/create` (host) or `/join/<CODE>` (guest) after sending a `register` JSON message; match `WEBSOCKET_PORT` (and host / TLS) to your web client’s `VITE_WEBSOCKET_*` settings.
