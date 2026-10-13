const $ = (id) => document.getElementById(id);
const home = $("home");
const call = $("call");
const status = $("status");
const detail = $("detail");
const invite = $("invite");
const joinButton = $("join");
const muteButton = $("mute");
const hangupButton = $("hangup");
const newCallButton = $("new-call");
const remoteAudio = $("remote-audio");
const peerConnections = new Map();
const pendingCandidates = new Map();
let roomId = location.pathname.match(/^\/call\/([a-zA-Z0-9_-]+)\/?$/)?.[1] || null;
let token = roomId ? getToken(roomId) : null;
let localStream = null;
let joined = false;
let statsTimer = null;
let pollLoopRunning = false;

function getToken(id) {
  const key = `quietcall:${id}`;
  let value = sessionStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem(key, value);
  }
  return value;
}

function showHome() {
  home.hidden = false;
  call.hidden = true;
}

function showCall() {
  home.hidden = true;
  call.hidden = false;
  invite.hidden = !roomId;
  joinButton.hidden = joined || !roomId;
  muteButton.hidden = !joined;
  hangupButton.hidden = !roomId || !joined;
  newCallButton.hidden = Boolean(roomId);
}

function setStatus(text, message = "") {
  status.textContent = text;
  detail.textContent = message;
}

async function post(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "Call service error.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function send(message) {
  const { type, ...body } = message;
  post(type === "signal" ? "signal" : type, body).then((result) => {
    if (type === "ready") handleMessage({ type: "ready", peers: result.peers });
  }).catch((error) => {
    if (joined) setStatus("Signaling interrupted", error.message);
  });
}

async function pollLoop() {
  if (pollLoopRunning) return;
  pollLoopRunning = true;
  while (joined) {
    try {
      const { messages } = await post("poll", { roomId, token });
      for (const message of messages) handleMessage(message);
    } catch (error) {
      if (error.status === 404 || error.status === 409) {
        clearInterval(statsTimer);
        for (const pc of peerConnections.values()) pc.close();
        peerConnections.clear();
        localStream?.getTracks().forEach((track) => track.stop());
        localStream = null;
        joined = false;
        showCall();
        joinButton.disabled = false;
        setStatus(error.status === 404 ? "Call link expired" : "Rejoin call", error.message);
        if (error.status === 404) {
          joinButton.hidden = true;
          newCallButton.hidden = false;
        }
        break;
      }
      if (joined) setStatus("Reconnecting", "Signaling connection interrupted. Retrying.");
    }
    if (joined) {
      const connected = [...peerConnections.values()].some((pc) => pc.connectionState === "connected");
      const negotiating = peerConnections.size > 0 && !connected;
      await new Promise((resolve) => setTimeout(resolve, negotiating ? 350 : 5000));
    }
  }
  pollLoopRunning = false;
}

async function createCall() {
  $("create").disabled = true;
  $("home-error").textContent = "";
  setStatus("Creating call…");
  showCall();
  try {
    token = crypto.randomUUID();
    const result = await post("create", { token });
    roomId = result.roomId;
    sessionStorage.setItem(`quietcall:${roomId}`, token);
    history.replaceState(null, "", `/call/${roomId}`);
    showCall();
    setStatus("Waiting for invitee", "Invite link expires after one hour if unused.");
  } catch (error) {
    $("create").disabled = false;
    showHome();
    $("home-error").textContent = `Could not create call: ${error.message}`;
  }
}

async function joinCall() {
  joinButton.disabled = true;
  setStatus("Allow microphone access", "Your browser will ask for microphone permission.");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    await post("join", { roomId, token });
    joined = true;
    send({ type: "ready" });
    showCall();
    setStatus("Waiting for other caller", "Microphone is on.");
    startStats();
    pollLoop();
  } catch (error) {
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    joinButton.disabled = false;
    showCall();
    setStatus("Could not join call", error.message || "Microphone access failed.");
  }
}

function signal(peerId, value) {
  send({ type: "signal", roomId, to: peerId, signal: value });
}

function getPeerConnection(peerId) {
  let pc = peerConnections.get(peerId);
  if (pc) return pc;

  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  peerConnections.set(peerId, pc);
  for (const track of localStream?.getTracks() || []) pc.addTrack(track, localStream);
  const transceiver = pc.getTransceivers().find((item) => item.sender.track?.kind === "audio");
  const codecs = RTCRtpSender.getCapabilities?.("audio")?.codecs || [];
  const opus = codecs.filter((codec) => codec.mimeType?.toLowerCase() === "audio/opus");
  if (opus.length && transceiver?.setCodecPreferences) {
    try { transceiver.setCodecPreferences([...opus, ...codecs.filter((codec) => !opus.includes(codec))]); } catch {}
  }
  pc.onicecandidate = ({ candidate }) => candidate && signal(peerId, { candidate });
  pc.ontrack = ({ streams }) => {
    remoteAudio.srcObject = streams[0];
    remoteAudio.play().catch(() => setStatus("Tap to hear", "Your browser blocked audio playback."));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") updateConnectionType(pc);
    else if (pc.connectionState === "connecting") setStatus("Connecting");
    else if (pc.connectionState === "disconnected") setStatus("Reconnecting");
    else if (pc.connectionState === "failed") setStatus("Connection failed", "Try another network or add TURN relay support.");
  };
  return pc;
}

async function limitAudioBitrate(pc) {
  const sender = pc.getSenders().find((item) => item.track?.kind === "audio");
  if (!sender) return;
  const parameters = sender.getParameters();
  parameters.encodings ??= [{}];
  parameters.encodings[0].maxBitrate = 24000;
  try { await sender.setParameters(parameters); } catch { /* Keep browser bitrate if unsupported. */ }
}

async function beginPeer(peerId) {
  if (!joined || !localStream || token.localeCompare(peerId) >= 0) return;
  const pc = getPeerConnection(peerId);
  if (pc.localDescription) return;
  try {
    await limitAudioBitrate(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal(peerId, { description: pc.localDescription });
  } catch {
    setStatus("Could not start audio", "Refresh and try again.");
  }
}

async function handleSignal(from, value) {
  if (!joined) return;
  const pc = getPeerConnection(from);
  try {
    if (value.description) {
      await pc.setRemoteDescription(value.description);
      for (const candidate of pendingCandidates.get(from) || []) await pc.addIceCandidate(candidate);
      pendingCandidates.delete(from);
      if (value.description.type === "offer") {
        await limitAudioBitrate(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal(from, { description: pc.localDescription });
      }
    } else if (value.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(value.candidate);
      else pendingCandidates.set(from, [...(pendingCandidates.get(from) || []), value.candidate]);
    }
  } catch {
    setStatus("Connection setup failed", "Try joining the call again.");
  }
}

async function updateConnectionType(pc) {
  const stats = await pc.getStats();
  let relayed = false;
  let weak = false;
  for (const report of stats.values()) {
    if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
      const local = stats.get(report.localCandidateId);
      const remote = stats.get(report.remoteCandidateId);
      relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
      weak ||= report.currentRoundTripTime > 0.6;
    }
    if (report.type === "remote-inbound-rtp" && report.kind === "audio") weak ||= report.fractionLost > 0.05;
  }
  setStatus(weak ? "Weak connection" : `Connected · ${relayed ? "Relayed" : "Direct"}`, weak ? "High delay or packet loss may affect speech." : "");
}

function startStats() {
  clearInterval(statsTimer);
  statsTimer = setInterval(() => {
    for (const pc of peerConnections.values()) {
      if (pc.connectionState === "connected") updateConnectionType(pc);
    }
  }, 5000);
}

function handleMessage(message) {
  if (message.type === "ready") {
    for (const peerId of message.peers) beginPeer(peerId);
  } else if (message.type === "peer-ready") {
    beginPeer(message.peerId);
  } else if (message.type === "signal") {
    handleSignal(message.from, message.signal);
  } else if (message.type === "peer-left") {
    peerConnections.get(message.peerId)?.close();
    peerConnections.delete(message.peerId);
    pendingCandidates.delete(message.peerId);
    remoteAudio.srcObject = null;
    setStatus("Waiting for other caller", "They can rejoin from the same link.");
  }
}

function hangUp() {
  post("leave", { roomId, token }).catch(() => {});
  clearInterval(statsTimer);
  for (const pc of peerConnections.values()) pc.close();
  peerConnections.clear();
  pendingCandidates.clear();
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  remoteAudio.srcObject = null;
  joined = false;
  showCall();
  joinButton.disabled = false;
  joinButton.hidden = true;
  hangupButton.hidden = true;
  muteButton.hidden = true;
  newCallButton.hidden = false;
  setStatus("Call ended");
}

$("create").addEventListener("click", createCall);
joinButton.addEventListener("click", joinCall);
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $("copy").textContent = "Link copied";
    setTimeout(() => { $("copy").textContent = "Copy invite link"; }, 2000);
  } catch {
    setStatus("Copy failed", "Copy the link from your browser address bar.");
  }
});
muteButton.addEventListener("click", () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  muteButton.textContent = track.enabled ? "Mute" : "Unmute";
});
hangupButton.addEventListener("click", () => hangUp());
newCallButton.addEventListener("click", () => { history.replaceState(null, "", "/"); location.reload(); });

if (roomId) {
  showCall();
  joinButton.hidden = false;
  setStatus("Ready to join", "This invite link expires after one hour if unused.");
} else {
  showHome();
}
