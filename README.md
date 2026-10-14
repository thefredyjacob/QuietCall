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
- In-call audio output picker lists browser-exposed devices after microphone permission. Browser support limits device switching, especially on mobile.
- The app shows the other caller's mute-button state through signaling; it cannot detect hardware or operating-system microphone mute.
- Google and Cloudflare STUN plus Metered Open Relay TURN fallback. Direct media remains peer-to-peer when possible; TURN relays only calls that need it.
- Anyone with the invite link can try to join. Share links privately.

## TURN setup

Create a Metered Open Relay credential for `notquietcall.metered.live`, then add this environment variable in Hostinger:

```text
METERED_TURN_API_KEY=<your TURN credential API key>
```

Keep the key in Hostinger's environment settings; do not put it in browser code or commit it. The app fetches TURN server credentials from Metered through its Node endpoint. If TURN is not configured or temporarily unavailable, calls fall back to direct STUN.

No accounts, database, video, chat, recording, or analytics.
