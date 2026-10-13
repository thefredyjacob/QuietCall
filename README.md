# QuietCall

Small one-to-one voice calls. Plain browser UI, Node.js HTTP signaling, WebRTC audio.

## Run

```sh
npm install
npm start
```

Open `http://localhost:3000` in two browsers. Microphone access requires HTTPS outside localhost.

## Deploy

Push this repository to GitHub, then import it as a Hostinger Node.js Web App. Select **Other** if asked for a framework, set `server.js` as the entry file, and use the HTTPS app domain. Signaling uses ordinary HTTP requests, so it does not need inbound WebSocket support.

## Calls

- Rooms allow two participants and use memory only.
- Unused rooms expire after one hour. Participants time out after 60 seconds without signaling polls; a room with one remaining participant expires after one hour.
- HTTP polling carries signaling only. WebRTC carries audio directly when possible.
- Audio uses mono Opus, browser audio processing, and a 24 kbps sender cap. Browser and network support affect the actual bitrate and quality.
- STUN is configured. TURN is not included yet; direct calls can fail behind restrictive NATs. Add a TURN service if real-world connection tests require it.
- Anyone with the invite link can try to join. Share links privately.

No accounts, database, video, chat, recording, or analytics.
