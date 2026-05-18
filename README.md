# GB-DrMario 💊

The **web client** and **server** for the online Dr. Mario project. Play Dr. Mario head-to-head on real Game Boy hardware over the internet using the GB link cable USB adapter.

Based on [gb-tetris-web](https://github.com/classictoni/gb-tetris-web/) and [gb-tetris-server](https://github.com/classictoni/gb-tetris-server/) by [classictoni](https://github.com/classictoni). Original base by [stacksmashing/gb-tetris-web](https://github.com/stacksmashing/gb-tetris-web) and [stacksmashing/gb-tetris-server](https://github.com/stacksmashing/gb-tetris-server).

## Requirements

- Game Boy with **Dr. Mario** cartridge  
- **Original GB-Link-Adapter** from stacksmashing, or newer **[GB Link](https://gblink.io/)**  
- **Chrome** or **Edge** (WebUSB support)

## Online demo

[https://drmario.gblink.io](https://drmario.gblink.io/)

## Web / frontend client

The browser UI for connecting to the Game Boys over WebUSB and coordinating with the **server / backend**. Builds a static site.

### Build and run

Install node dependencies:

```
cd web
npm install
```

Run development server:

```
npm run dev
```

Note that WebUSB is only supported with HTTPS. The dev server uses a local self-signed certificate; your browser will warn on first visit. Click through for localhost.

Copy `template.env` to `.env.local` and set `VITE_WEBSOCKET_HOST` and `VITE_WEBSOCKET_PORT` to match your backend.

## Server / backend

Python WebSocket coordinator for the project. Acts as the master for connecting Game Boys as slaves.

### Build and run

Requires Python 3.11+. Install dependencies:

```
cd server
pip install websockets python-dotenv
```

Copy `template.env` to `.env` and configure:

```
WEBSOCKET_PORT=5678
```

Run the server:

```
python server.py
```

To enable TLS set `USE_SSL=true` and fill in `FULLCHAIN_CERT_PATH` and `PRIVKEY_PATH` in `.env`.

## TODO

- Improve the post-session flow after three consecutive wins.
- Support different GB Link firmwares.

## Support

If you find this project useful, consider supporting ongoing development on Ko-fi.

<a href="https://ko-fi.com/raphaelzdev"><img src="https://storage.ko-fi.com/cdn/brandasset/v2/support_me_on_kofi_dark.png" width="200" alt="Support me on Ko-fi"></a>

## Credits

- **raphaelz**, [raphaelz.com](https://raphaelz.com)
- **Starlark** (testing and hosting), [https://github.com/starlarkus](https://github.com/starlarkus)
