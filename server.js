import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const port = Number(process.env.PORT || 3000);
const rooms = new Map();
const inviteTtl = 60 * 60 * 1000;
const inactiveTtl = 60 * 1000;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function json(response, code, body) {
  response.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendTo(peer, message) {
  if (!peer.joined) return;
  if (peer.messages.length >= 100) peer.messages.shift();
  peer.messages.push(message);
}

function removeRoom(room) {
  clearTimeout(room.expiry);
  rooms.delete(room.id);
}

function armExpiry(room) {
  if (room.expiry) return;
  room.expiry = setTimeout(() => removeRoom(room), inviteTtl);
  room.expiry.unref?.();
}

function refreshExpiry(room) {
  const joined = room.peers.filter((peer) => peer.joined).length;
  if (joined === 2) {
    clearTimeout(room.expiry);
    room.expiry = null;
  } else {
    armExpiry(room);
  }
  if (!room.peers.length) removeRoom(room);
}

function removePeer(room, peer) {
  room.peers = room.peers.filter((item) => item !== peer);
  for (const other of room.peers) sendTo(other, { type: "peer-left", peerId: peer.token });
  refreshExpiry(room);
}

function cleanStalePeers() {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const peer of [...room.peers]) {
      if (peer.joined && now - peer.lastSeen > inactiveTtl) removePeer(room, peer);
    }
  }
}

function validToken(token) {
  return typeof token === "string" && /^[a-f0-9-]{36}$/i.test(token);
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16 * 1024) throw new Error("Request too large.");
  }
  return JSON.parse(body || "{}");
}

function api(request, response, body) {
  cleanStalePeers();
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/api/health" && request.method === "GET") {
    return json(response, 200, { status: "ok", runtime: process.version, uptimeSeconds: Math.floor(process.uptime()) });
  }
  if (request.method !== "POST") return json(response, 405, { error: "POST required." });

  if (path === "/api/create") {
    if (!validToken(body.token)) return json(response, 400, { error: "Invalid call token." });
    const id = randomBytes(9).toString("base64url");
    const room = {
      id,
      peers: [{ token: body.token, joined: false, ready: false, lastSeen: Date.now(), messages: [] }],
      expiry: null,
    };
    rooms.set(id, room);
    armExpiry(room);
    return json(response, 201, { roomId: id });
  }

  const room = rooms.get(body.roomId);
  if (!room) return json(response, 404, { error: "This call link expired or does not exist." });
  if (!validToken(body.token)) return json(response, 400, { error: "Invalid call token." });
  let peer = room.peers.find((item) => item.token === body.token);

  if (path === "/api/join") {
    if (!peer) {
      if (room.peers.length >= 2) return json(response, 409, { error: "This call is full." });
      peer = { token: body.token, joined: false, ready: false, lastSeen: Date.now(), messages: [] };
      room.peers.push(peer);
    }
    if (peer.joined) {
      for (const other of room.peers) {
        if (other !== peer) sendTo(other, { type: "peer-left", peerId: peer.token });
      }
    }
    peer.joined = true;
    peer.ready = false;
    peer.lastSeen = Date.now();
    peer.messages.length = 0;
    refreshExpiry(room);
    return json(response, 200, { peers: room.peers.filter((item) => item !== peer && item.joined).map((item) => item.token) });
  }

  if (!peer?.joined) return json(response, 409, { error: "Join the call first." });
  peer.lastSeen = Date.now();

  if (path === "/api/ready") {
    peer.ready = true;
    const readyPeers = room.peers.filter((item) => item !== peer && item.joined && item.ready);
    for (const other of readyPeers) sendTo(other, { type: "peer-ready", peerId: peer.token });
    return json(response, 200, { peers: readyPeers.map((item) => item.token) });
  }

  if (path === "/api/signal") {
    const recipient = room.peers.find((item) => item.token === body.to && item.joined);
    if (!recipient || !body.signal || typeof body.signal !== "object") return json(response, 400, { error: "Invalid signal." });
    sendTo(recipient, { type: "signal", from: peer.token, signal: body.signal });
    return json(response, 202, { ok: true });
  }

  if (path === "/api/poll") {
    return json(response, 200, { messages: peer.messages.splice(0) });
  }

  if (path === "/api/leave") {
    removePeer(room, peer);
    return json(response, 200, { ok: true });
  }

  return json(response, 404, { error: "Not found." });
}

const http = createServer(async (request, response) => {
  const requestPath = new URL(request.url, "http://localhost").pathname;
  const requestId = randomBytes(6).toString("hex");
  const started = performance.now();
  response.setHeader("X-Request-ID", requestId);
  if (requestPath.startsWith("/api/")) {
    response.on("finish", () => {
      if (requestPath !== "/api/poll" || response.statusCode >= 400) {
        console.log(JSON.stringify({ type: "api-request", requestId, method: request.method, endpoint: requestPath, status: response.statusCode, durationMs: Math.round(performance.now() - started) }));
      }
    });
    try {
      api(request, response, await readJson(request));
    } catch (error) {
      console.error(JSON.stringify({ type: "api-error", requestId, endpoint: requestPath, error: error.message === "Request too large." ? error.message : "Invalid JSON request." }));
      json(response, error.message === "Request too large." ? 413 : 400, { error: error.message || "Invalid request." });
    }
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const requested = pathname === "/" || pathname.startsWith("/call/")
    ? "index.html"
    : ["/app.js", "/style.css"].includes(pathname) ? pathname.slice(1) : null;
  if (!requested) {
    response.writeHead(404).end("Not found");
    return;
  }

  const file = join(root, requested);
  createReadStream(file)
    .on("error", () => response.writeHead(404).end("Not found"))
    .on("open", () => response.writeHead(200, {
      "Content-Type": mimeTypes[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    }))
    .pipe(response);
});

http.listen(port, "0.0.0.0", () => console.log(`Voice app listening on ${port}`));
