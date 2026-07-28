// ── Vapi credentials ────────────────────────────────────────────────────
// The public key is safe to expose in client-side code -- it only allows
// starting calls with assistants you own, nothing account-sensitive.
const VAPI_PUBLIC_KEY = "3388caa0-5327-423e-ab13-f79c5480ee80";
const VAPI_ASSISTANT_ID = "f60a01ba-ca4d-4b28-a5d4-8f54a0c523dc";
// ────────────────────────────────────────────────────────────────────────
//
// NOTE: this page must be served over http://localhost or https:// --
// opening index.html directly as a file:// URL will not work, because
// browsers block ES module imports and microphone access on file://.

const micButton = document.getElementById("micButton");
const micIcon = document.getElementById("micIcon");
const stopIcon = document.getElementById("stopIcon");
const orbRing = document.getElementById("orbRing");
const statusText = document.getElementById("statusText");
const transcriptBody = document.getElementById("transcriptBody");
const transcriptEmpty = document.getElementById("transcriptEmpty");
const transcriptHint = document.getElementById("transcriptHint");

const BOT_AVATAR = `<svg viewBox="0 0 64 64" width="14" height="14" fill="none"><g stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 27h31v13a11 11 0 0 1-11 11H24a11 11 0 0 1-11-11V27Z"/><path d="M44 31h4.5a6.5 6.5 0 0 1 0 13H44"/></g></svg>`;
const USER_AVATAR = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none"><path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z" stroke="currentColor" stroke-width="2"/><path d="M4 20.5c1.6-4 4.8-6 8-6s6.4 2 8 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

// Keeps consecutive partial transcripts for the same speaker updating in
// place instead of spamming a new bubble on every word.
let liveBubble = null;
let liveRole = null;

function clearTranscript() {
  transcriptBody.querySelectorAll(".msg").forEach((el) => el.remove());
  transcriptEmpty.style.display = "flex";
  transcriptHint.classList.remove("on");
  liveBubble = null;
  liveRole = null;
}

function appendTranscript(role, text) {
  if (!text) return;
  transcriptEmpty.style.display = "none";
  transcriptHint.classList.add("on");

  if (liveBubble && liveRole === role) {
    liveBubble.textContent = text;
  } else {
    const row = document.createElement("div");
    row.className = "msg " + (role === "user" ? "msg-user" : "msg-bot");
    row.innerHTML =
      `<span class="msg-avatar">${role === "user" ? USER_AVATAR : BOT_AVATAR}</span>` +
      `<div class="msg-bubble"><span class="msg-role">${role === "user" ? "You" : "Brew Bot"}</span><p class="msg-text"></p></div>`;
    transcriptBody.appendChild(row);
    liveBubble = row.querySelector(".msg-text");
    liveBubble.textContent = text;
    liveRole = role;
  }

  transcriptBody.scrollTop = transcriptBody.scrollHeight;
}

function finalizeTranscriptLine() {
  liveBubble = null;
  liveRole = null;
}

let Vapi = null;      // the SDK constructor, loaded lazily
let vapi = null;      // the live client instance
let callActive = false;
let busy = false;     // guards against double-clicks starting two calls

function setStatus(text) {
  statusText.textContent = text;
}

function setButtonState(state) {
  // state: "idle" | "connecting" | "active"
  micButton.classList.remove("connecting", "active");
  orbRing.classList.remove("pulse");
  micIcon.style.display = "block";
  stopIcon.style.display = "none";

  if (state === "connecting") {
    micButton.classList.add("connecting");
  } else if (state === "active") {
    micButton.classList.add("active");
    orbRing.classList.add("pulse");
    micIcon.style.display = "none";
    stopIcon.style.display = "block";
  }
}

function goIdle(message) {
  callActive = false;
  setButtonState("idle");
  setStatus(message || "Tap to start");
}

function goActive() {
  callActive = true;
  setButtonState("active");
  setStatus("Listening...");
}

// Loaded on first click rather than at page load, so that a CDN failure
// surfaces as a readable message instead of killing the whole module.
async function loadSdk() {
  if (Vapi) return Vapi;
  const sources = [
    "https://esm.sh/@vapi-ai/web@2.6.1",
    "https://cdn.jsdelivr.net/npm/@vapi-ai/web@2.6.1/+esm",
  ];
  let lastErr;
  for (const url of sources) {
    try {
      Vapi = (await import(url)).default;
      return Vapi;
    } catch (err) {
      lastErr = err;
      console.warn("Vapi SDK failed to load from", url, err);
    }
  }
  throw new Error("Could not load the voice SDK: " + (lastErr && lastErr.message));
}

function initVapi() {
  if (vapi) return vapi;

  vapi = new Vapi(VAPI_PUBLIC_KEY);

  vapi.on("call-start", goActive);

  vapi.on("call-end", () => goIdle());

  vapi.on("speech-start", () => {
    if (callActive) setStatus("Brew Bot is speaking...");
  });

  vapi.on("speech-end", () => {
    if (callActive) setStatus("Listening...");
  });

  vapi.on("message", (message) => {
    if (message.type !== "transcript") return;
    appendTranscript(message.role, message.transcript);
    if (message.transcriptType === "final") finalizeTranscriptLine();
  });

  vapi.on("call-start-failed", (info) => {
    console.error("Vapi call-start-failed:", info);
    goIdle("Couldn't connect. Check the assistant ID and try again.");
  });

  vapi.on("error", (err) => {
    console.error("Vapi error:", err);
    const detail = err && (err.errorMsg || err.message);
    goIdle(detail ? "Error: " + detail : "Something went wrong. Please try again.");
  });

  return vapi;
}

async function toggleCall() {
  if (busy) return;

  if (callActive) {
    vapi.stop();
    goIdle("Ending call...");
    return;
  }

  // Fail fast with a specific reason rather than hanging on "Connecting..."
  if (!window.isSecureContext) {
    setStatus("Open this page via http://localhost, not as a file://");
    return;
  }

  busy = true;
  setButtonState("connecting");
  setStatus("Connecting...");
  clearTranscript();

  try {
    await loadSdk();

    // Ask for the mic up front so a denied permission is reported clearly.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (permErr) {
      console.error("Microphone unavailable:", permErr);
      goIdle("Microphone blocked. Allow mic access in your browser, then retry.");
      return;
    }

    const client = initVapi();
    await client.start(VAPI_ASSISTANT_ID);

    // Don't depend solely on the call-start event -- if it was missed, the
    // button would otherwise stay stuck in the dimmed "connecting" state.
    if (!callActive) goActive();
  } catch (err) {
    console.error("Failed to start call:", err);
    goIdle("Couldn't start the call: " + (err && err.message ? err.message : "unknown error"));
  } finally {
    busy = false;
  }
}

micButton.addEventListener("click", toggleCall);

// End the call cleanly if the tab is closed or reloaded mid-conversation.
window.addEventListener("pagehide", () => {
  if (vapi && callActive) vapi.stop();
});
