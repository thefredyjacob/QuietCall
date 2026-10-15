const $ = (id) => document.getElementById(id);
const home = $("home");
const call = $("call");
const status = $("status");
const detail = $("detail");
const invite = $("invite");
const joinButton = $("join");
const muteButton = $("mute");
const audioOutputButton = $("audio-output");
const audioOutputNote = $("audio-output-note");
const audioDevicePanel = $("audio-device-panel");
const audioInputSelect = $("audio-input");
const audioOutputSelect = $("audio-output-select");
const chooseAudioOutputButton = $("choose-audio-output");
const foregroundHint = $("foreground-hint");
const backgroundInfo = $("background-info");
const hangupButton = $("hangup");
const newCallButton = $("new-call");
const remoteAudio = $("remote-audio");
const peerConnections = new Map();
const pendingCandidates = new Map();
let roomId = location.pathname.match(/^\/call\/([a-zA-Z0-9_-]+)\/?$/)?.[1] || null;
let token = roomId ? getToken(roomId) : null;
let localStream = null;
let joined = false;
let screenWakeLock = null;
let hiddenAt = null;
let audioSessionActive = false;
let mediaStopControlActive = false;
let statsTimer = null;
let pollLoopRunning = false;
let iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];
const diagnosticEvents = [];
const peerDiagnostics = new Map();
const lastApiLog = new Map();

function logEvent(event, details = {}) {
  const item = { time: new Date().toISOString(), event, ...details };
  diagnosticEvents.push(item);
  if (diagnosticEvents.length > 100) diagnosticEvents.shift();
  console.info("[QuietCall]", event, details);
  renderDiagnostics();
}

function logApi(event, details, key) {
  const now = Date.now();
  if (now - (lastApiLog.get(key) || 0) < 5000) return;
  lastApiLog.set(key, now);
  logEvent(event, details);
}

function renderDiagnostics() {
  const report = {
    capturedAt: new Date().toISOString(),
    app: "QuietCall",
    page: `${location.origin}${roomId ? "/call/[redacted]" : "/"}`,
    browser: navigator.userAgent,
    device: deviceFamily(),
    secureContext: isSecureContext,
    online: navigator.onLine,
    microphoneApiAvailable: Boolean(navigator.mediaDevices?.getUserMedia),
    audioOutputRoutingAvailable: typeof remoteAudio.setSinkId === "function",
    audioOutputPickerAvailable: typeof navigator.mediaDevices?.selectAudioOutput === "function",
    audioInputDeviceCount: audioInputSelect.options.length - 1,
    audioOutputDeviceCount: audioOutputSelect.options.length - 1,
    audioSessionApiAvailable: Boolean(navigator.audioSession),
    screenWakeLockAvailable: Boolean(navigator.wakeLock?.request),
    mediaSessionAvailable: Boolean(navigator.mediaSession?.setActionHandler),
    events: diagnosticEvents,
    peers: [...peerDiagnostics.values()],
  };
  $("diagnostic-report").textContent = JSON.stringify(report, null, 2);
}

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
  const canSelectAudioOutput = typeof remoteAudio.setSinkId === "function" && typeof navigator.mediaDevices?.selectAudioOutput === "function";
  audioOutputButton.hidden = !joined;
  if (!joined) {
    audioDevicePanel.hidden = true;
    audioOutputButton.setAttribute("aria-expanded", "false");
  }
  chooseAudioOutputButton.hidden = !joined || typeof remoteAudio.setSinkId !== "function" || typeof navigator.mediaDevices?.selectAudioOutput !== "function";
  if (!joined || canSelectAudioOutput) audioOutputNote.hidden = true;
  hangupButton.hidden = !roomId || !joined;
  newCallButton.hidden = Boolean(roomId);
}

function deviceFamily() {
  const agent = navigator.userAgent || "";
  if (/Android/i.test(agent)) return "Android";
  if (/iPhone|iPad|iPod/i.test(agent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPhone or iPad";
  return "desktop";
}

function updateBackgroundInfo() {
  if (!joined) {
    foregroundHint.hidden = true;
    return;
  }
  foregroundHint.hidden = false;
  if (document.visibilityState === "hidden") {
    backgroundInfo.textContent = "QuietCall is in the background. Your browser may interrupt the call; return here if audio stops.";
    return;
  }
  const family = deviceFamily();
  const guidance = family === "iPhone or iPad"
    ? "On iPhone/iPad, keep QuietCall open. iOS may pause a browser call in the background; a website cannot start a native VoIP background service."
    : family === "Android"
      ? "On Android, the browser may keep the call active, but QuietCall cannot start a native microphone foreground service from a website. Switching apps can interrupt it."
      : "On desktop, calls usually continue in another tab. Keep the browser open; this is browser-managed, not a native call service.";
  const active = [
    audioSessionActive ? "Call audio mode active." : "Browser-managed call audio.",
    screenWakeLock && !screenWakeLock.released ? "Screen held awake while this tab is visible." : "",
    mediaStopControlActive ? "System stop control registered." : "",
  ].filter(Boolean).join(" ");
  backgroundInfo.textContent = `${active} ${guidance}`;
}

function activateAudioSession() {
  if (!navigator.audioSession) return false;
  try {
    navigator.audioSession.type = "play-and-record";
    audioSessionActive = navigator.audioSession.type === "play-and-record";
    logEvent("audio-session", { type: navigator.audioSession.type, active: audioSessionActive });
  } catch (error) {
    logEvent("audio-session-unavailable", { name: error.name, message: error.message });
  }
  return audioSessionActive;
}

function activateSystemCallControls() {
  const session = navigator.mediaSession;
  if (!session?.setActionHandler) return;
  try {
    if (typeof MediaMetadata === "function") session.metadata = new MediaMetadata({ title: "QuietCall voice call", artist: "QuietCall" });
    session.setActionHandler("stop", hangUp);
    mediaStopControlActive = true;
    session.playbackState = "playing";
    logEvent("system-call-control", { action: "stop", active: true });
    updateBackgroundInfo();
  } catch (error) {
    logEvent("system-call-control-unavailable", { name: error.name, message: error.message });
  }
}

function clearSystemCallControls() {
  try {
    navigator.mediaSession?.setActionHandler("stop", null);
    if (navigator.mediaSession) {
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.metadata = null;
    }
  } catch {}
  mediaStopControlActive = false;
  if (audioSessionActive) {
    try { navigator.audioSession.type = "auto"; } catch {}
  }
  audioSessionActive = false;
}

function showAudioOutputHelp() {
  const family = deviceFamily();
  audioOutputNote.textContent = family === "Android"
    ? "Choose speaker, earpiece, or Bluetooth from Android’s media output or Bluetooth controls. This browser does not expose an in-call output picker."
    : family === "iPhone or iPad"
      ? "Choose Speaker or a connected headset from Control Center. This browser does not expose an in-call output picker."
      : "Choose the output device in your computer’s sound settings. This browser does not expose an in-call output picker.";
  audioOutputNote.hidden = false;
}

function setDeviceOptions(select, devices, defaultLabel, prefix, preferredValue = select.value) {
  select.replaceChildren(new Option(defaultLabel, ""));
  const available = devices.filter((device) => device.deviceId && device.deviceId !== "default");
  available.forEach((device, index) => select.add(new Option(device.label || `${prefix} ${index + 1}`, device.deviceId)));
  if (available.some((device) => device.deviceId === preferredValue)) select.value = preferredValue;
}

async function refreshAudioDevices(preferredOutputId) {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    const outputs = devices.filter((device) => device.kind === "audiooutput");
    const selectedInput = localStream?.getAudioTracks()[0]?.getSettings().deviceId || audioInputSelect.value;
    setDeviceOptions(audioInputSelect, inputs, "System default microphone", "Microphone", selectedInput);
    setDeviceOptions(audioOutputSelect, outputs, "System default output", "Speaker", preferredOutputId ?? remoteAudio.sinkId ?? audioOutputSelect.value);
    audioOutputSelect.disabled = typeof remoteAudio.setSinkId !== "function";
    audioOutputNote.hidden = false;
    audioOutputNote.textContent = audioOutputSelect.disabled
      ? "This browser cannot select an output here. Use your device’s audio controls."
      : outputs.length > 1
        ? "Choose an available output. Use More output devices to grant access to another speaker or headset."
        : "Choose More output devices to select a speaker or headset.";
    logEvent("audio-devices-listed", { microphones: inputs.length, outputs: outputs.length });
  } catch (error) {
    logEvent("audio-devices-list-failed", { name: error.name, message: error.message });
    audioOutputNote.hidden = false;
    audioOutputNote.textContent = "Could not list audio devices. Check browser permissions and try again.";
  }
}

async function switchMicrophone(deviceId) {
  const previousStream = localStream;
  const previousTrack = previousStream?.getAudioTracks()[0];
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  if (deviceId) audio.deviceId = { exact: deviceId };

  let nextStream;
  try {
    nextStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const nextTrack = nextStream.getAudioTracks()[0];
    nextTrack.enabled = previousTrack?.enabled ?? true;
    const senders = [...peerConnections.values()].flatMap((pc) => pc.getSenders()).filter((sender) => sender.track === previousTrack);
    const replaced = [];
    try {
      for (const sender of senders) {
        await sender.replaceTrack(nextTrack);
        replaced.push(sender);
      }
    } catch (error) {
      await Promise.allSettled(replaced.map((sender) => sender.replaceTrack(previousTrack)));
      throw error;
    }
    localStream = nextStream;
    previousStream?.getTracks().forEach((track) => track.stop());
    const settings = nextTrack.getSettings();
    logEvent("microphone-changed", { deviceSelected: Boolean(deviceId), settings: Object.fromEntries(["sampleRate", "channelCount", "echoCancellation", "noiseSuppression", "autoGainControl"].filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]])) });
    audioOutputNote.hidden = false;
    audioOutputNote.textContent = "Microphone changed without ending the call.";
  } catch (error) {
    nextStream?.getTracks().forEach((track) => track.stop());
    audioInputSelect.value = previousTrack?.getSettings().deviceId || "";
    logEvent("microphone-change-failed", { name: error.name, message: error.message });
    audioOutputNote.hidden = false;
    audioOutputNote.textContent = `Could not change microphone: ${error.message || "check microphone permissions."}`;
  }
}

async function switchSpeaker(deviceId) {
  try {
    await remoteAudio.setSinkId(deviceId);
    audioOutputNote.hidden = false;
    audioOutputNote.textContent = deviceId ? `Playing through ${audioOutputSelect.selectedOptions[0]?.textContent || "selected output"}.` : "Playing through the system default output.";
    logEvent("audio-output-changed", { deviceSelected: Boolean(deviceId) });
  } catch (error) {
    audioOutputNote.hidden = false;
    audioOutputNote.textContent = `Could not change output: ${error.message || "use your device’s audio controls."}`;
    logEvent("audio-output-change-failed", { name: error.name, message: error.message });
    audioOutputSelect.value = remoteAudio.sinkId || "";
  }
}

function setStatus(text, message = "") {
  status.textContent = text;
  const state = text.toLowerCase();
  status.closest(".connection-chip").dataset.state = state.includes("connected")
    ? "connected"
    : /failed|ended|expired|could not/.test(state)
      ? "error"
      : /weak|reconnect|interrupted/.test(state)
        ? "warning"
        : "waiting";
  detail.textContent = message;
}

async function post(path, body) {
  const started = performance.now();
  try {
    const response = await fetch(`/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let result;
    try { result = await response.json(); }
    catch { result = { error: `Server returned a non-JSON response (HTTP ${response.status}).` }; }
    const requestId = response.headers.get("x-request-id") || undefined;
    if (path !== "poll" || !response.ok) logApi("api", { endpoint: path, status: response.status, ms: Math.round(performance.now() - started), requestId }, `${path}:${response.status}`);
    if (!response.ok) {
      const error = new Error(result.error || "Call service error.");
      error.status = response.status;
      error.requestId = requestId;
      logApi("api-error", { endpoint: path, status: response.status, message: error.message, requestId }, `error:${path}:${response.status}`);
      $("diagnostics").open = true;
      throw error;
    }
    return result;
  } catch (error) {
    if (!error.status) logApi("api-network-error", { endpoint: path, message: error.message }, `network:${path}`);
    throw error;
  }
}

async function checkService() {
  const started = performance.now();
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const result = await response.json();
    logEvent("service-check", { status: response.status, ms: Math.round(performance.now() - started), server: result });
  } catch (error) {
    logEvent("service-check-failed", { message: error.message });
  }
}

async function requestScreenWakeLock() {
  if (document.visibilityState !== "visible" || (screenWakeLock && !screenWakeLock.released)) return;
  if (!navigator.wakeLock?.request) {
    updateBackgroundInfo();
    logEvent("screen-wake-lock-unavailable", { reason: "unsupported" });
    return;
  }
  try {
    const lock = await navigator.wakeLock.request("screen");
    screenWakeLock = lock;
    updateBackgroundInfo();
    logEvent("screen-wake-lock", { state: "active" });
    lock.addEventListener("release", () => {
      if (screenWakeLock === lock) screenWakeLock = null;
      logEvent("screen-wake-lock", { state: "released" });
      if (joined && document.visibilityState === "visible") {
        updateBackgroundInfo();
      }
    }, { once: true });
  } catch (error) {
    updateBackgroundInfo();
    logEvent("screen-wake-lock-unavailable", { name: error.name, message: error.message });
  }
}

function releaseScreenWakeLock() {
  screenWakeLock?.release().catch(() => {});
  screenWakeLock = null;
  updateBackgroundInfo();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    logEvent("page-hidden", { joined });
    updateBackgroundInfo();
  } else {
    logEvent("page-visible", { joined, hiddenForMs: hiddenAt === null ? 0 : Date.now() - hiddenAt });
    hiddenAt = null;
    if (joined) requestScreenWakeLock();
    updateBackgroundInfo();
  }
});

async function configureIceServers() {
  try {
    const result = await post("ice-servers", { roomId, token });
    const turnServers = Array.isArray(result.iceServers) ? result.iceServers : [];
    iceServers = [...iceServers, ...turnServers];
    logEvent("turn-configured", { available: result.turnAvailable, serverCount: turnServers.length });
  } catch (error) {
    logEvent("turn-unavailable", { status: error.status, message: error.message, fallback: "STUN direct connection" });
  }
}

function send(message) {
  const { type, ...body } = message;
  post(type === "signal" ? "signal" : type, { roomId, token, ...body }).then((result) => {
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
        releaseScreenWakeLock();
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
    logEvent("room-created");
  } catch (error) {
    logEvent("room-create-failed", { message: error.message, status: error.status });
    $("create").disabled = false;
    showHome();
    $("home-error").textContent = `Could not create call: ${error.message}`;
  }
}

async function joinCall() {
  joinButton.disabled = true;
  await requestScreenWakeLock();
  activateAudioSession();
  logEvent("microphone-requested");
  setStatus("Allow microphone access", "Your browser will ask for microphone permission.");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    const track = localStream.getAudioTracks()[0];
    const settings = track?.getSettings() || {};
    logEvent("microphone-ready", { settings: Object.fromEntries(["sampleRate", "channelCount", "echoCancellation", "noiseSuppression", "autoGainControl"].filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]])), enabled: track?.enabled });
    await post("join", { roomId, token });
    logEvent("room-joined");
    joined = true;
    await requestScreenWakeLock();
    await refreshAudioDevices();
    updateBackgroundInfo();
    await configureIceServers();
    send({ type: "ready" });
    showCall();
    setStatus("Waiting for other caller", "Microphone is on.");
    startStats();
    pollLoop();
  } catch (error) {
    logEvent("join-failed", { name: error.name, message: error.message, status: error.status });
    releaseScreenWakeLock();
    clearSystemCallControls();
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
    iceServers,
  });
  peerConnections.set(peerId, pc);
  peerDiagnostics.set(pc, { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, signalingState: pc.signalingState, localCandidates: [], remoteCandidates: [] });
  for (const track of localStream?.getTracks() || []) pc.addTrack(track, localStream);
  const transceiver = pc.getTransceivers().find((item) => item.sender.track?.kind === "audio");
  const codecs = RTCRtpSender.getCapabilities?.("audio")?.codecs || [];
  const opus = codecs.filter((codec) => codec.mimeType?.toLowerCase() === "audio/opus");
  if (opus.length && transceiver?.setCodecPreferences) {
    try { transceiver.setCodecPreferences([...opus, ...codecs.filter((codec) => !opus.includes(codec))]); } catch {}
  }
  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) return logEvent("ice-gathering-complete");
    const type = candidate.candidate.match(/\btyp\s+(host|srflx|prflx|relay)\b/)?.[1] || "unknown";
    const info = peerDiagnostics.get(pc);
    if (!info.localCandidates.includes(type)) info.localCandidates.push(type);
    logEvent("ice-local-candidate", { type });
    signal(peerId, { candidate });
  };
  pc.onicecandidateerror = ({ errorCode }) => logEvent("ice-candidate-error", { code: errorCode });
  pc.oniceconnectionstatechange = () => {
    const info = peerDiagnostics.get(pc);
    info.iceConnectionState = pc.iceConnectionState;
    logEvent("ice-state", { state: pc.iceConnectionState });
  };
  pc.onsignalingstatechange = () => {
    const info = peerDiagnostics.get(pc);
    info.signalingState = pc.signalingState;
    logEvent("signaling-state", { state: pc.signalingState });
  };
  pc.onicegatheringstatechange = () => {
    const info = peerDiagnostics.get(pc);
    info.iceGatheringState = pc.iceGatheringState;
    logEvent("ice-gathering-state", { state: pc.iceGatheringState });
  };
  pc.ontrack = ({ streams }) => {
    remoteAudio.srcObject = streams[0];
    logEvent("remote-audio-track", { streamCount: streams.length });
    remoteAudio.play().then(activateSystemCallControls).catch((error) => { logEvent("audio-playback-blocked", { message: error.message }); setStatus("Tap to hear", "Your browser blocked audio playback."); });
  };
  pc.onconnectionstatechange = () => {
    const info = peerDiagnostics.get(pc);
    info.connectionState = pc.connectionState;
    logEvent("peer-connection-state", { state: pc.connectionState });
    if (pc.connectionState === "connected") updateConnectionType(pc);
    else if (pc.connectionState === "connecting") setStatus("Connecting");
    else if (pc.connectionState === "disconnected") setStatus("Reconnecting");
    else if (pc.connectionState === "failed") {
      $("diagnostics").open = true;
      const info = peerDiagnostics.get(pc);
      const noRelay = ![...(info.localCandidates || []), ...(info.remoteCandidates || [])].includes("relay");
      setStatus("Connection failed", "Open connection diagnostics to see where setup stopped.");
      logEvent("connection-failed", { hint: pc.iceConnectionState === "failed" && noRelay ? "ICE failed without relay candidates; a TURN path may be needed." : "Inspect the recorded ICE and signaling states." });
    }
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
    logEvent("offer-created");
    signal(peerId, { description: pc.localDescription });
  } catch (error) {
    logEvent("offer-failed", { name: error.name, message: error.message });
    setStatus("Could not start audio", "Refresh and try again.");
  }
}

async function handleSignal(from, value) {
  if (!joined) return;
  const pc = getPeerConnection(from);
  try {
    if (value.description) {
      logEvent("description-received", { type: value.description.type });
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
      const type = value.candidate.candidate.match(/\btyp\s+(host|srflx|prflx|relay)\b/)?.[1] || "unknown";
      const info = peerDiagnostics.get(pc);
      if (!info.remoteCandidates.includes(type)) info.remoteCandidates.push(type);
      logEvent("ice-remote-candidate", { type });
      if (pc.remoteDescription) await pc.addIceCandidate(value.candidate);
      else pendingCandidates.set(from, [...(pendingCandidates.get(from) || []), value.candidate]);
    }
  } catch (error) {
    logEvent("signal-processing-failed", { name: error.name, message: error.message });
    setStatus("Connection setup failed", "Try joining the call again.");
  }
}

async function updateConnectionType(pc) {
  let stats;
  try { stats = await pc.getStats(); }
  catch (error) { logApi("stats-failed", { name: error.name, message: error.message }, "stats-failed"); return; }
  let relayed = false;
  let weak = false;
  let audio = {};
  let selectedPair = null;
  for (const report of stats.values()) {
    if (report.type === "transport" && report.selectedCandidatePairId) selectedPair = stats.get(report.selectedCandidatePairId);
  }
  for (const report of stats.values()) {
    if (report.type === "candidate-pair" && report.state === "succeeded" && (report.selected || report.nominated)) {
      selectedPair ||= report;
    }
    if (report === selectedPair) {
      const local = stats.get(report.localCandidateId);
      const remote = stats.get(report.remoteCandidateId);
      relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
      weak ||= report.currentRoundTripTime > 0.6;
      audio.rttMs = Math.round((report.currentRoundTripTime || 0) * 1000);
    }
    if (report.kind === "audio" && (report.type === "inbound-rtp" || report.type === "outbound-rtp")) {
      const direction = report.type === "inbound-rtp" ? "received" : "sent";
      audio[`${direction}Bytes`] = report.bytesReceived ?? report.bytesSent ?? 0;
      audio[`${direction}Packets`] = report.packetsReceived ?? report.packetsSent ?? 0;
      if (report.type === "inbound-rtp") audio.jitterMs = Math.round((report.jitter || 0) * 1000);
    }
    if (report.type === "remote-inbound-rtp" && report.kind === "audio") {
      audio.packetLossPercent = Math.round((report.fractionLost || 0) * 1000) / 10;
      weak ||= report.fractionLost > 0.05;
    }
    if (report.type === "codec" && report.mimeType?.startsWith("audio/")) audio.codec = report.mimeType;
  }
  const info = peerDiagnostics.get(pc);
  if (info) Object.assign(info, { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, audio });
  renderDiagnostics();
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
  releaseScreenWakeLock();
  clearSystemCallControls();
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
$("check-service").addEventListener("click", checkService);
$("copy-diagnostics").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("diagnostic-report").textContent);
    $("copy-diagnostics").textContent = "Report copied";
    setTimeout(() => { $("copy-diagnostics").textContent = "Copy report"; }, 2000);
  } catch (error) {
    logEvent("diagnostic-copy-failed", { message: error.message });
  }
});
window.addEventListener("online", () => logEvent("browser-online"));
window.addEventListener("offline", () => logEvent("browser-offline"));
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $("copy").querySelector("span").textContent = "Link copied";
    setTimeout(() => { $("copy").querySelector("span").textContent = "Copy invite link"; }, 2000);
  } catch {
    setStatus("Copy failed", "Copy the link from your browser address bar.");
  }
});
muteButton.addEventListener("click", () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("mute-label").textContent = track.enabled ? "Mute" : "Unmute";
  muteButton.setAttribute("aria-label", track.enabled ? "Mute microphone" : "Unmute microphone");
  muteButton.setAttribute("aria-pressed", String(!track.enabled));
});
audioOutputButton.addEventListener("click", async () => {
  audioDevicePanel.hidden = !audioDevicePanel.hidden;
  audioOutputButton.setAttribute("aria-expanded", String(!audioDevicePanel.hidden));
  if (audioDevicePanel.hidden) return;
  await refreshAudioDevices();
  if (typeof remoteAudio.setSinkId !== "function") showAudioOutputHelp();
});
audioInputSelect.addEventListener("change", () => switchMicrophone(audioInputSelect.value));
audioOutputSelect.addEventListener("change", () => switchSpeaker(audioOutputSelect.value));
chooseAudioOutputButton.addEventListener("click", async () => {
  try {
    const device = await navigator.mediaDevices.selectAudioOutput();
    await refreshAudioDevices(device.deviceId);
    await switchSpeaker(device.deviceId);
  } catch (error) {
    logEvent("audio-output-change-failed", { name: error.name, message: error.message });
    audioOutputNote.hidden = false;
    audioOutputNote.textContent = error.name === "NotAllowedError"
      ? "Audio output was not changed. Try again or use your device’s audio controls."
      : `Could not switch output: ${error.message || "Use your device’s audio controls."}`;
  }
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  if (joined) refreshAudioDevices();
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
logEvent("app-loaded", { protocol: location.protocol });
