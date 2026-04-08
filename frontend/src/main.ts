/**
 * JARVIS — Main entry point.
 *
 * Wires together the orb visualization, WebSocket communication,
 * speech recognition, and audio playback into a single experience.
 */

import { createOrb, type OrbState } from "./orb";
import { createVoiceInput, createAudioPlayer } from "./voice";
import { createSocket } from "./ws";
import { openSettings, checkFirstTimeSetup } from "./settings";
import "./style.css";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type State = "idle" | "listening" | "thinking" | "speaking";
let currentState: State = "idle";
let isMuted = false;

const statusEl = document.getElementById("status-text")!;
const errorEl = document.getElementById("error-text")!;

function showError(msg: string) {
  errorEl.textContent = msg;
  errorEl.style.opacity = "1";
  setTimeout(() => {
    errorEl.style.opacity = "0";
  }, 5000);
}

function updateStatus(state: State) {
  const labels: Record<State, string> = {
    idle: "",
    listening: "listening...",
    thinking: "thinking...",
    speaking: "",
  };
  statusEl.textContent = labels[state];
}

// ---------------------------------------------------------------------------
// Init components
// ---------------------------------------------------------------------------

const canvas = document.getElementById("orb-canvas") as HTMLCanvasElement;
const orb = createOrb(canvas);

const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = `${wsProto}//${window.location.host}/ws/voice`;
const socket = createSocket(WS_URL);

const audioPlayer = createAudioPlayer();
orb.setAnalyser(audioPlayer.getAnalyser());

function transition(newState: State) {
  if (newState === currentState) return;
  currentState = newState;
  orb.setState(newState as OrbState);
  updateStatus(newState);

  switch (newState) {
    case "idle":
      if (!isMuted) voiceInput.resume();
      break;
    case "listening":
      if (!isMuted) voiceInput.resume();
      break;
    case "thinking":
      voiceInput.pause();
      break;
    case "speaking":
      voiceInput.pause();
      break;
  }
}

// ---------------------------------------------------------------------------
// Voice input
// ---------------------------------------------------------------------------

const voiceInput = createVoiceInput(
  (text: string) => {
    // Cancel any current JARVIS response before sending new input
    audioPlayer.stop();
    // User spoke — send transcript
    socket.send({ type: "transcript", text, isFinal: true });
    transition("thinking");
  },
  (msg: string) => {
    showError(msg);
  }
);

// ---------------------------------------------------------------------------
// Audio playback finished
// ---------------------------------------------------------------------------

audioPlayer.onFinished(() => {
  transition("idle");
});

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

socket.onMessage((msg) => {
  const type = msg.type as string;

  if (type === "audio") {
    const audioData = msg.data as string;
    console.log("[audio] received", audioData ? `${audioData.length} chars` : "EMPTY", "state:", currentState);
    if (audioData) {
      if (currentState !== "speaking") {
        transition("speaking");
      }
      audioPlayer.enqueue(audioData);
    } else {
      // TTS failed — no audio but still need to return to idle
      console.warn("[audio] no data received, returning to idle");
      transition("idle");
    }
    // Log text for debugging
    if (msg.text) console.log("[JARVIS]", msg.text);
  } else if (type === "request_screenshot") {
    captureAndSendScreenshot();
  } else if (type === "status") {
    const state = msg.state as string;
    if (state === "thinking" && currentState !== "thinking") {
      transition("thinking");
    } else if (state === "working") {
      transition("thinking");
      statusEl.textContent = "working...";
    } else if (state === "idle") {
      transition("idle");
    }
  } else if (type === "text") {
    // Text fallback when TTS fails
    console.log("[JARVIS]", msg.text);
  } else if (type === "task_spawned") {
    console.log("[task]", "spawned:", msg.task_id, msg.prompt);
  } else if (type === "task_complete") {
    console.log("[task]", "complete:", msg.task_id, msg.status, msg.summary);
  }
});

// ---------------------------------------------------------------------------
// Kick off
// ---------------------------------------------------------------------------

// Start listening after a brief delay for the orb to render
setTimeout(() => {
  voiceInput.start();
  transition("listening");
}, 1000);

// Resume AudioContext on ANY user interaction (browser autoplay policy)
function ensureAudioContext() {
  const ctx = audioPlayer.getAnalyser().context as AudioContext;
  if (ctx.state === "suspended") {
    ctx.resume().then(() => console.log("[audio] context resumed"));
  }
}
document.addEventListener("click", ensureAudioContext);
document.addEventListener("touchstart", ensureAudioContext);
document.addEventListener("keydown", ensureAudioContext, { once: true });

// Try to resume audio context on load
ensureAudioContext();

// ---------------------------------------------------------------------------
// UI Controls
// ---------------------------------------------------------------------------

const btnMute = document.getElementById("btn-mute")!;
const btnMenu = document.getElementById("btn-menu")!;
const menuDropdown = document.getElementById("menu-dropdown")!;
const btnRestart = document.getElementById("btn-restart")!;
const btnFixSelf = document.getElementById("btn-fix-self")!;

btnMute.addEventListener("click", (e) => {
  e.stopPropagation();
  isMuted = !isMuted;
  btnMute.classList.toggle("muted", isMuted);
  if (isMuted) {
    voiceInput.pause();
    transition("idle");
  } else {
    voiceInput.resume();
    transition("listening");
  }
});

btnMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  menuDropdown.style.display = menuDropdown.style.display === "none" ? "block" : "none";
});

document.addEventListener("click", () => {
  menuDropdown.style.display = "none";
});

btnRestart.addEventListener("click", async (e) => {
  e.stopPropagation();
  menuDropdown.style.display = "none";
  statusEl.textContent = "restarting...";
  try {
    await fetch("/api/restart", { method: "POST" });
    // Wait a few seconds then reload
    setTimeout(() => window.location.reload(), 4000);
  } catch {
    statusEl.textContent = "restart failed";
  }
});

btnFixSelf.addEventListener("click", (e) => {
  e.stopPropagation();
  menuDropdown.style.display = "none";
  // Activate work mode on the WebSocket session (JARVIS becomes Claude Code's voice)
  socket.send({ type: "fix_self" });
  statusEl.textContent = "entering work mode...";
});

// ---------------------------------------------------------------------------
// Screen capture
// ---------------------------------------------------------------------------

async function captureAndSendScreenshot() {
  try {
    const stream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    const canvas = document.createElement("canvas");
    const settings = track.getSettings();
    canvas.width = settings.width || 1920;
    canvas.height = settings.height || 1080;

    // Use ImageCapture if available, otherwise video element
    if ((window as any).ImageCapture) {
      const imageCapture = new (window as any).ImageCapture(track);
      const bitmap = await imageCapture.grabFrame();
      track.stop();
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
    } else {
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      track.stop();
    }

    const dataUrl = canvas.toDataURL("image/png");
    socket.send({ type: "screenshot", data: dataUrl });
  } catch (e) {
    console.warn("[screenshot] failed:", e);
    socket.send({ type: "screenshot", data: "" });
  }
}

// ---------------------------------------------------------------------------
// Log Viewer
// ---------------------------------------------------------------------------

const logsContainer = document.getElementById("logs-container")!;
const logsOutput = document.getElementById("logs-output")!;
const btnLogsClose = document.getElementById("btn-logs-close")!;
const btnLogsClear = document.getElementById("btn-logs-clear")!;
const btnLogs = document.getElementById("btn-logs")!;

let logsSocket: WebSocket | null = null;

function openLogs() {
  logsContainer.classList.add("open");
  if (!logsSocket || logsSocket.readyState !== WebSocket.OPEN) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    logsSocket = new WebSocket(`${proto}//${window.location.host}/ws/logs`);
    logsSocket.onmessage = (e) => {
      if (e.data === "ping") return;
      const line = document.createElement("div");
      line.className = "log-line";
      const text = e.data as string;
      if (text.includes("ERROR") || text.includes("error")) line.classList.add("error");
      else if (text.includes("WARNING") || text.includes("warn")) line.classList.add("warn");
      else line.classList.add("info");
      line.textContent = text;
      logsOutput.appendChild(line);
      logsOutput.scrollTop = logsOutput.scrollHeight;
    };
  }
}

function closeLogs() {
  logsContainer.classList.remove("open");
}

btnLogs.addEventListener("click", (e) => {
  e.stopPropagation();
  menuDropdown.style.display = "none";
  openLogs();
});

btnLogsClose.addEventListener("click", closeLogs);
btnLogsClear.addEventListener("click", () => { logsOutput.innerHTML = ""; });
logsContainer.querySelector(".logs-backdrop")!.addEventListener("click", closeLogs);

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

const btnImage = document.getElementById("btn-image") as HTMLButtonElement;
const imageFileInput = document.getElementById("image-file-input") as HTMLInputElement;
const imagePreviewBar = document.getElementById("image-preview-bar") as HTMLDivElement;
const imagePreview = document.getElementById("image-preview") as HTMLImageElement;
const btnImageRemove = document.getElementById("btn-image-remove") as HTMLButtonElement;
let pendingImageData: string | null = null;

function setImage(dataUrl: string) {
  pendingImageData = dataUrl;
  imagePreview.src = dataUrl;
  imagePreviewBar.style.display = "flex";
  btnImage.classList.add("has-image");
}

function clearImage() {
  pendingImageData = null;
  imagePreview.src = "";
  imagePreviewBar.style.display = "none";
  btnImage.classList.remove("has-image");
  imageFileInput.value = "";
}

btnImage.addEventListener("click", (e) => {
  e.stopPropagation();
  imageFileInput.click();
});

btnImageRemove.addEventListener("click", (e) => {
  e.stopPropagation();
  clearImage();
});

imageFileInput.addEventListener("change", () => {
  const file = imageFileInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => setImage(e.target!.result as string);
  reader.readAsDataURL(file);
});

// Drag & drop onto the whole page
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith("image/")) {
    const reader = new FileReader();
    reader.onload = (ev) => setImage(ev.target!.result as string);
    reader.readAsDataURL(file);
  }
});

// Text input
const textInput = document.getElementById("text-input") as HTMLInputElement;
const btnSend = document.getElementById("btn-send")!;

function sendTextInput() {
  const text = textInput.value.trim();
  if (!text && !pendingImageData) return;
  audioPlayer.stop();
  if (pendingImageData) {
    socket.send({ type: "image", data: pendingImageData, prompt: text });
    clearImage();
  } else {
    socket.send({ type: "transcript", text, isFinal: true });
  }
  textInput.value = "";
  transition("thinking");
}

btnSend.addEventListener("click", (e) => {
  e.stopPropagation();
  sendTextInput();
});

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendTextInput();
  }
});

// Settings button
const btnSettings = document.getElementById("btn-settings")!;
btnSettings.addEventListener("click", (e) => {
  e.stopPropagation();
  menuDropdown.style.display = "none";
  openSettings();
});

// First-time setup detection — check after a short delay for server readiness
setTimeout(() => {
  checkFirstTimeSetup();
}, 2000);
