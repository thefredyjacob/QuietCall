const $ = (id) => document.getElementById(id);
const home = $("home");
const call = $("call");
const status = $("status");
const detail = $("detail");
const invite = $("invite");
const copyLinkButton = $("copy-link");
const remoteParticipant = $("remote-participant");
const localParticipantStatus = $("local-participant-status");
const remoteParticipantStatus = $("remote-participant-status");
const joinButton = $("join");
const shareButton = $("share-link");
const shareNote = $("share-note");
const muteButton = $("mute");
const pipButton = $("pip-open");
const pipNote = $("pip-note");
const audioOutputButton = $("audio-output");
const audioOutputNote = $("audio-output-note");
const audioDevicePanel = $("audio-device-panel");
const audioInputSelect = $("audio-input");
const audioOutputSelect = $("audio-output-select");
const chooseAudioOutputButton = $("choose-audio-output");
const hangupButton = $("hangup");
const newCallButton = $("new-call");
const remoteAudio = $("remote-audio");
const peerConnections = new Map();
const pendingCandidates = new Map();
let roomId = location.pathname.match(/^\/call\/([a-zA-Z0-9_-]+)\/?$/)?.[1] || null;
let token = roomId ? getToken(roomId) : null;
let localStream = null;
let joined = false;
let callConnected = false;
let remotePresent = false;
let remoteMuted = false;
let callGeneration = 0;
let screenWakeLock = null;
let hiddenAt = null;
let audioSessionActive = false;
let pipWindow = null;
let pipOpening = false;
let shareNoteTimer = null;
let statsTimer = null;
let pollController = null;
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
    documentPictureInPictureAvailable: typeof window.documentPictureInPicture?.requestWindow === "function",
    pictureInPictureOpen: Boolean(pipWindow && !pipWindow.closed),
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
  joinButton.hidden = !roomId || callConnected;
  setJoinButtonPresentation(joined ? status.textContent === "Waiting for other caller" ? "Waiting for other caller" : "Joining call…" : "Join call", true, joined);
  muteButton.hidden = !joined;
  pipButton.hidden = !joined || typeof window.documentPictureInPicture?.requestWindow !== "function";
  if (!joined) pipNote.hidden = true;
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

function updateParticipantStatuses() {
  localParticipantStatus.textContent = callConnected ? "Connected" : joined ? status.textContent : status.textContent === "Ready to join" ? "Not joined" : status.textContent;
  remoteParticipantStatus.textContent = callConnected ? remoteMuted ? "Connected · Muted" : "Connected" : remotePresent ? "Joining call…" : joined ? "Waiting for caller" : "Not connected";
}

function setRemotePresent(present) {
  remotePresent = present;
  if (!present) remoteMuted = false;
  remoteParticipant.classList.toggle("remote-present", present);
  updateParticipantStatuses();
}

function advanceCallGeneration() {
  callGeneration += 1;
  pollController?.abort();
  pollController = null;
  return callGeneration;
}

function setJoinButtonPresentation(label, prominent, busy) {
  joinButton.querySelector(".control-label").textContent = label;
  joinButton.classList.toggle("join-attention", prominent);
  joinButton.setAttribute("aria-busy", String(busy));
}

function deviceFamily() {
  const agent = navigator.userAgent || "";
  if (/Android/i.test(agent)) return "Android";
  if (/iPhone|iPad|iPod/i.test(agent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPhone or iPad";
  return "desktop";
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
    session.playbackState = "playing";
    logEvent("system-call-control", { action: "stop", active: true });
  } catch (error) {
    logEvent("system-call-control-unavailable", { name: error.name, message: error.message });
  }
}

function activateCallPictureInPicture() {
  const session = navigator.mediaSession;
  if (!session?.setActionHandler || typeof window.documentPictureInPicture?.requestWindow !== "function") return;
  try {
    session.setActionHandler("enterpictureinpicture", () => { void openCallPictureInPicture("automatic"); });
    logEvent("call-pip-handler", { active: true });
  } catch (error) {
    logEvent("call-pip-handler-unavailable", { name: error.name, message: error.message });
  }
}

function syncPictureInPicture() {
  if (!pipWindow || pipWindow.closed) return;
  const pipStatus = pipWindow.document.getElementById("pip-status");
  const pipDetail = pipWindow.document.getElementById("pip-detail");
  const pipMute = pipWindow.document.getElementById("pip-mute");
  const track = localStream?.getAudioTracks()[0];
  if (pipStatus) pipStatus.textContent = status.textContent;
  if (pipDetail) pipDetail.textContent = detail.textContent;
  if (pipMute && track) {
    pipMute.textContent = track.enabled ? "Mute" : "Unmute";
    pipMute.setAttribute("aria-pressed", String(!track.enabled));
  }
}

async function openCallPictureInPicture(source = "manual") {
  const api = window.documentPictureInPicture;
  if (!joined || typeof api?.requestWindow !== "function") return;
  if (pipWindow && !pipWindow.closed) {
    pipWindow.focus();
    return;
  }
  if (pipOpening) return;

  let nextWindow;
  pipOpening = true;
  try {
    nextWindow = await api.requestWindow({ width: 340, height: 190 });
    if (!joined) {
      nextWindow.close();
      return;
    }
    pipWindow = nextWindow;
    const doc = nextWindow.document;
    doc.title = "QuietCall";
    doc.body.className = "pip-document";
    const stylesheet = doc.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("/style.css", location.origin).href;
    doc.head.append(stylesheet);
    doc.body.innerHTML = `<main class="pip-call"><div class="pip-call-heading"><strong>QuietCall</strong><span id="pip-status" aria-live="polite"></span></div><p id="pip-detail"></p><div class="pip-controls"><button id="pip-mute" type="button" aria-pressed="false">Mute</button><button id="pip-hangup" type="button">Hang up</button></div></main>`;
    doc.getElementById("pip-mute").addEventListener("click", toggleMute);
    doc.getElementById("pip-hangup").addEventListener("click", hangUp);
    nextWindow.addEventListener("pagehide", () => {
      if (pipWindow === nextWindow) pipWindow = null;
      logEvent("call-pip-closed");
      renderDiagnostics();
    }, { once: true });
    pipNote.hidden = true;
    logEvent("call-pip-opened", { source });
    syncPictureInPicture();
    renderDiagnostics();
  } catch (error) {
    if (nextWindow && !nextWindow.closed) nextWindow.close();
    pipWindow = null;
    logEvent("call-pip-open-failed", { source, name: error.name, message: error.message });
    if (source === "manual") {
      pipNote.textContent = "Picture-in-picture was blocked. Check this site’s browser permission.";
      pipNote.hidden = false;
    }
    renderDiagnostics();
  } finally {
    pipOpening = false;
  }
}

function closeCallPictureInPicture() {
  const current = pipWindow;
  pipWindow = null;
  if (current && !current.closed) current.close();
  renderDiagnostics();
}

function closePeer(peerId) {
  const pc = peerConnections.get(peerId);
  if (!pc) return;
  peerConnections.delete(peerId);
  peerDiagnostics.delete(pc);
  pc.close();
}

function closeAllPeers() {
  for (const peerId of peerConnections.keys()) closePeer(peerId);
  peerConnections.clear();
  pendingCandidates.clear();
  peerDiagnostics.clear();
}

function syncMuteControls() {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  $("mute-label").textContent = track.enabled ? "Mute" : "Unmute";
  muteButton.setAttribute("aria-label", track.enabled ? "Mute microphone" : "Unmute microphone");
  muteButton.setAttribute("aria-pressed", String(!track.enabled));
  syncPictureInPicture();
}

function toggleMute() {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  syncMuteControls();
  for (const peerId of peerConnections.keys()) signal(peerId, { muted: !track.enabled });
}

function clearSystemCallControls() {
  try { navigator.mediaSession?.setActionHandler("stop", null); } catch {}
  try { navigator.mediaSession?.setActionHandler("enterpictureinpicture", null); } catch {}
  try {
    if (navigator.mediaSession) {
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.metadata = null;
    }
  } catch {}
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
  if (joined && !callConnected && !joinButton.hidden) {
    setJoinButtonPresentation(text === "Waiting for other caller" ? text : "Joining call…", true, true);
  }
  updateParticipantStatuses();
  syncPictureInPicture();
}

async function post(path, body, signal) {
  const started = performance.now();
  try {
    const response = await fetch(`/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
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
    logEvent("screen-wake-lock-unavailable", { reason: "unsupported" });
    return;
  }
  try {
    const lock = await navigator.wakeLock.request("screen");
    screenWakeLock = lock;
    logEvent("screen-wake-lock", { state: "active" });
    lock.addEventListener("release", () => {
      if (screenWakeLock === lock) screenWakeLock = null;
      logEvent("screen-wake-lock", { state: "released" });
    }, { once: true });
  } catch (error) {
    logEvent("screen-wake-lock-unavailable", { name: error.name, message: error.message });
  }
}

function releaseScreenWakeLock() {
  screenWakeLock?.release().catch(() => {});
  screenWakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    logEvent("page-hidden", { joined });
  } else {
    logEvent("page-visible", { joined, hiddenForMs: hiddenAt === null ? 0 : Date.now() - hiddenAt });
    hiddenAt = null;
    closeCallPictureInPicture();
    if (joined) requestScreenWakeLock();
  }
});

async function configureIceServers(generation, room, peerToken) {
  try {
    const result = await post("ice-servers", { roomId: room, token: peerToken });
    if (generation !== callGeneration) return;
    const turnServers = Array.isArray(result.iceServers) ? result.iceServers : [];
    iceServers = [...iceServers, ...turnServers];
    logEvent("turn-configured", { available: result.turnAvailable, serverCount: turnServers.length });
  } catch (error) {
    if (generation !== callGeneration) return;
    logEvent("turn-unavailable", { status: error.status, message: error.message, fallback: "STUN direct connection" });
  }
}

function send(message, generation = callGeneration) {
  const room = roomId;
  const peerToken = token;
  const { type, ...body } = message;
  post(type === "signal" ? "signal" : type, { roomId: room, token: peerToken, ...body }).then((result) => {
    if (generation !== callGeneration) return;
    if (type === "ready") handleMessage({ type: "ready", peers: result.peers }, generation);
  }).catch((error) => {
    if (generation === callGeneration && joined) setStatus("Signaling interrupted", error.message);
  });
}

async function pollLoop(generation, room, peerToken) {
  while (joined && generation === callGeneration) {
    const controller = new AbortController();
    pollController = controller;
    try {
      const { messages } = await post("poll", { roomId: room, token: peerToken }, controller.signal);
      if (generation !== callGeneration) break;
      for (const message of messages) handleMessage(message, generation);
    } catch (error) {
      if (generation !== callGeneration || error.name === "AbortError") break;
      if (error.status === 404 || error.status === 409) {
        clearInterval(statsTimer);
        closeAllPeers();
        localStream?.getTracks().forEach((track) => track.stop());
        localStream = null;
        remoteAudio.srcObject = null;
        joined = false;
        callConnected = false;
        setRemotePresent(false);
        advanceCallGeneration();
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
    } finally {
      if (pollController === controller) pollController = null;
    }
    if (joined && generation === callGeneration) {
      const connected = [...peerConnections.values()].some((pc) => pc.connectionState === "connected");
      const negotiating = peerConnections.size > 0 && !connected;
      await new Promise((resolve) => setTimeout(resolve, negotiating ? 350 : 5000));
    }
  }
}

async function createCall() {
  const generation = advanceCallGeneration();
  const restarting = Boolean(roomId);
  const previousToken = token;
  $("create").disabled = true;
  if (restarting) {
    newCallButton.disabled = true;
    invite.hidden = true;
  }
  $("home-error").textContent = "";
  setStatus("Creating call…");
  showCall();
  if (restarting) invite.hidden = true;
  try {
    token = crypto.randomUUID();
    const result = await post("create", { token });
    if (generation !== callGeneration) return;
    roomId = result.roomId;
    sessionStorage.setItem(`quietcall:${roomId}`, token);
    history.replaceState(null, "", `/call/${roomId}`);
    showCall();
    setStatus("Waiting for invitee", "Invite link expires after one hour if unused.");
    logEvent("room-created");
    await joinCall(generation);
  } catch (error) {
    if (generation !== callGeneration) return;
    logEvent("room-create-failed", { message: error.message, status: error.status });
    if (restarting) token = previousToken;
    $("create").disabled = false;
    if (restarting) {
      newCallButton.disabled = false;
      showCall();
      newCallButton.hidden = false;
      setStatus("Could not create call", error.message);
    } else {
      showHome();
      $("home-error").textContent = `Could not create call: ${error.message}`;
    }
  }
}

async function joinCall(generation = callGeneration) {
  const joiningRoom = roomId;
  const joiningToken = token;
  let joiningStream;
  joinButton.disabled = true;
  setJoinButtonPresentation("Joining call…", true, true);
  await requestScreenWakeLock();
  if (generation !== callGeneration) return;
  activateAudioSession();
  logEvent("microphone-requested");
  setStatus("Allow microphone access", "Your browser will ask for microphone permission.");
  try {
    joiningStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    if (generation !== callGeneration) {
      joiningStream.getTracks().forEach((track) => track.stop());
      return;
    }
    localStream = joiningStream;
    const track = localStream.getAudioTracks()[0];
    const settings = track?.getSettings() || {};
    logEvent("microphone-ready", { settings: Object.fromEntries(["sampleRate", "channelCount", "echoCancellation", "noiseSuppression", "autoGainControl"].filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]])), enabled: track?.enabled });
    await post("join", { roomId: joiningRoom, token: joiningToken });
    if (generation !== callGeneration) {
      joiningStream.getTracks().forEach((track) => track.stop());
      post("leave", { roomId: joiningRoom, token: joiningToken }).catch(() => {});
      return;
    }
    logEvent("room-joined");
    joined = true;
    setRemotePresent(false);
    activateCallPictureInPicture();
    await requestScreenWakeLock();
    if (generation !== callGeneration) return;
    await refreshAudioDevices();
    if (generation !== callGeneration) return;
    await configureIceServers(generation, joiningRoom, joiningToken);
    if (generation !== callGeneration) return;
    send({ type: "ready" }, generation);
    setStatus("Waiting for other caller", "Microphone is on.");
    showCall();
    startStats(generation);
    pollLoop(generation, joiningRoom, joiningToken);
  } catch (error) {
    if (generation !== callGeneration) {
      joiningStream?.getTracks().forEach((track) => track.stop());
      return;
    }
    logEvent("join-failed", { name: error.name, message: error.message, status: error.status });
    releaseScreenWakeLock();
    clearSystemCallControls();
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    joined = false;
    callConnected = false;
    setRemotePresent(false);
    joinButton.disabled = false;
    showCall();
    setStatus("Could not join call", error.message || "Microphone access failed.");
  }
}

function signal(peerId, value, generation = callGeneration) {
  send({ type: "signal", to: peerId, signal: value }, generation);
}

function getPeerConnection(peerId, generation = callGeneration) {
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
    if (generation !== callGeneration || !peerConnections.has(peerId)) return;
    if (!candidate) return logEvent("ice-gathering-complete");
    const type = candidate.candidate.match(/\btyp\s+(host|srflx|prflx|relay)\b/)?.[1] || "unknown";
    const info = peerDiagnostics.get(pc);
    if (!info.localCandidates.includes(type)) info.localCandidates.push(type);
    logEvent("ice-local-candidate", { type });
    signal(peerId, { candidate }, generation);
  };
  pc.onicecandidateerror = ({ errorCode }) => { if (generation === callGeneration && peerConnections.has(peerId)) logEvent("ice-candidate-error", { code: errorCode }); };
  pc.oniceconnectionstatechange = () => {
    if (generation !== callGeneration || !peerDiagnostics.has(pc)) return;
    const info = peerDiagnostics.get(pc);
    info.iceConnectionState = pc.iceConnectionState;
    logEvent("ice-state", { state: pc.iceConnectionState });
  };
  pc.onsignalingstatechange = () => {
    if (generation !== callGeneration || !peerDiagnostics.has(pc)) return;
    const info = peerDiagnostics.get(pc);
    info.signalingState = pc.signalingState;
    logEvent("signaling-state", { state: pc.signalingState });
  };
  pc.onicegatheringstatechange = () => {
    if (generation !== callGeneration || !peerDiagnostics.has(pc)) return;
    const info = peerDiagnostics.get(pc);
    info.iceGatheringState = pc.iceGatheringState;
    logEvent("ice-gathering-state", { state: pc.iceGatheringState });
  };
  pc.ontrack = ({ streams }) => {
    if (generation !== callGeneration) return;
    remoteAudio.srcObject = streams[0];
    logEvent("remote-audio-track", { streamCount: streams.length });
    remoteAudio.play().then(() => {
      if (generation === callGeneration && joined) activateSystemCallControls();
    }).catch((error) => {
      if (generation !== callGeneration) return;
      logEvent("audio-playback-blocked", { message: error.message });
      setStatus("Tap to hear", "Your browser blocked audio playback.");
    });
  };
  pc.onconnectionstatechange = () => {
    if (generation !== callGeneration || !peerDiagnostics.has(pc)) return;
    const info = peerDiagnostics.get(pc);
    info.connectionState = pc.connectionState;
    logEvent("peer-connection-state", { state: pc.connectionState });
    if (pc.connectionState === "connected") {
      callConnected = true;
      setRemotePresent(true);
      showCall();
      updateConnectionType(pc, generation);
    }
    else if (pc.connectionState === "connecting") setStatus("Connecting");
    else if (pc.connectionState === "disconnected") setStatus("Reconnecting");
    else if (pc.connectionState === "failed") {
      $("diagnostics").open = true;
      const info = peerDiagnostics.get(pc);
      const noRelay = ![...(info.localCandidates || []), ...(info.remoteCandidates || [])].includes("relay");
      closePeer(peerId);
      callConnected = false;
      remoteAudio.srcObject = null;
      setRemotePresent(false);
      showCall();
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

async function beginPeer(peerId, generation = callGeneration) {
  if (generation !== callGeneration || !joined || !localStream || token.localeCompare(peerId) >= 0) return;
  const pc = getPeerConnection(peerId, generation);
  if (pc.localDescription) return;
  try {
    await limitAudioBitrate(pc);
    if (generation !== callGeneration) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (generation !== callGeneration) return;
    logEvent("offer-created");
    signal(peerId, { description: pc.localDescription }, generation);
  } catch (error) {
    if (generation !== callGeneration) return;
    logEvent("offer-failed", { name: error.name, message: error.message });
    setStatus("Could not start audio", "Refresh and try again.");
  }
}

async function handleSignal(from, value, generation = callGeneration) {
  if (!joined || generation !== callGeneration) return;
  if (typeof value.muted === "boolean") {
    remoteMuted = value.muted;
    updateParticipantStatuses();
    return;
  }
  const pc = getPeerConnection(from, generation);
  try {
    if (value.description) {
      logEvent("description-received", { type: value.description.type });
      await pc.setRemoteDescription(value.description);
      if (generation !== callGeneration) return;
      for (const candidate of pendingCandidates.get(from) || []) await pc.addIceCandidate(candidate);
      pendingCandidates.delete(from);
      if (value.description.type === "offer") {
        await limitAudioBitrate(pc);
        if (generation !== callGeneration) return;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (generation !== callGeneration) return;
        signal(from, { description: pc.localDescription }, generation);
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
    if (generation !== callGeneration) return;
    logEvent("signal-processing-failed", { name: error.name, message: error.message });
    setStatus("Connection setup failed", "Try joining the call again.");
  }
}

async function updateConnectionType(pc, generation = callGeneration) {
  let stats;
  try { stats = await pc.getStats(); }
  catch (error) { logApi("stats-failed", { name: error.name, message: error.message }, "stats-failed"); return; }
  if (generation !== callGeneration || !peerDiagnostics.has(pc)) return;
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

function startStats(generation = callGeneration) {
  clearInterval(statsTimer);
  statsTimer = setInterval(() => {
    if (generation !== callGeneration) return clearInterval(statsTimer);
    for (const pc of peerConnections.values()) {
      if (pc.connectionState === "connected") updateConnectionType(pc, generation);
    }
  }, 5000);
}

function handleMessage(message, generation = callGeneration) {
  if (!joined || generation !== callGeneration) return;
  if (message.type === "ready") {
    if (message.peers.length) {
      setRemotePresent(true);
      setStatus("Connecting");
    }
    for (const peerId of message.peers) {
      beginPeer(peerId, generation);
      signal(peerId, { muted: Boolean(localStream?.getAudioTracks()[0] && !localStream.getAudioTracks()[0].enabled) }, generation);
    }
  } else if (message.type === "peer-ready") {
    setRemotePresent(true);
    setStatus("Connecting");
    beginPeer(message.peerId, generation);
    const track = localStream?.getAudioTracks()[0];
    signal(message.peerId, { muted: Boolean(track && !track.enabled) }, generation);
  } else if (message.type === "signal") {
    handleSignal(message.from, message.signal, generation);
  } else if (message.type === "peer-left") {
    closePeer(message.peerId);
    pendingCandidates.delete(message.peerId);
    callConnected = false;
    setRemotePresent(false);
    remoteAudio.srcObject = null;
    showCall();
    setStatus("Waiting for other caller", "They can rejoin from the same link.");
  }
}

function hangUp() {
  const room = roomId;
  const peerToken = token;
  advanceCallGeneration();
  post("leave", { roomId: room, token: peerToken }).catch(() => {});
  clearInterval(statsTimer);
  closeAllPeers();
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  remoteAudio.srcObject = null;
  joined = false;
  callConnected = false;
  setRemotePresent(false);
  closeCallPictureInPicture();
  releaseScreenWakeLock();
  clearSystemCallControls();
  showCall();
  joinButton.disabled = false;
  joinButton.hidden = true;
  hangupButton.hidden = true;
  muteButton.hidden = true;
  newCallButton.hidden = false;
  newCallButton.disabled = false;
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
function showShareNote(message) {
  clearTimeout(shareNoteTimer);
  shareNote.textContent = message;
  shareNote.hidden = false;
  shareNoteTimer = setTimeout(() => { shareNote.hidden = true; }, 5000);
}

async function copyInviteLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    showShareNote("Call link copied. Share via your favourite app.");
    logEvent("invite-link-copied");
  } catch (error) {
    showShareNote("Could not copy link. Copy it from the address bar.");
    logEvent("invite-link-copy-failed", { name: error.name, message: error.message });
  }
}

shareButton.addEventListener("click", async () => {
  if (!navigator.share) return copyInviteLink();
  showShareNote("Share this call link with one person.");
  try {
    await navigator.share({ title: "QuietCall voice call", text: "Join my QuietCall call", url: location.href });
    showShareNote("Call link shared.");
    logEvent("native-share-opened");
  } catch (error) {
    if (error.name === "AbortError") {
      showShareNote("Sharing cancelled.");
      return;
    }
    logEvent("native-share-failed", { name: error.name, message: error.message });
    await copyInviteLink();
  }
});
copyLinkButton.addEventListener("click", copyInviteLink);
muteButton.addEventListener("click", toggleMute);
pipButton.addEventListener("click", () => openCallPictureInPicture("manual"));
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
newCallButton.addEventListener("click", createCall);

if (roomId) {
  showCall();
  joinButton.hidden = false;
  setStatus("Ready to join", "This invite link expires after one hour if unused.");
} else {
  showHome();
}
logEvent("app-loaded", { protocol: location.protocol });
