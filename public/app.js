const AUDIO_SAMPLE_RATE = 24_000;

const elements = {
  status: document.querySelector("#status"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  startMicrophone: document.querySelector("#start-microphone"),
  stopMicrophone: document.querySelector("#stop-microphone"),
  interrupt: document.querySelector("#interrupt"),
  textForm: document.querySelector("#text-form"),
  textInput: document.querySelector("#text-input"),
  sendText: document.querySelector("#send-text"),
  userTranscript: document.querySelector("#user-transcript"),
  assistantTranscript: document.querySelector("#assistant-transcript"),
  errors: document.querySelector("#errors"),
};

let socket;
let microphoneStream;
let microphoneContext;
let microphoneSource;
let microphoneProcessor;
let playbackContext;
let playbackTime = 0;
const playingSources = new Set();

function setStatus(label, state) {
  elements.status.textContent = label;
  elements.status.dataset.state = state;
}

function setConnectedControls(connected) {
  elements.connect.disabled = connected;
  elements.disconnect.disabled = !connected;
  elements.startMicrophone.disabled = !connected;
  elements.interrupt.disabled = !connected;
  elements.textInput.disabled = !connected;
  elements.sendText.disabled = !connected;
  if (!connected) {
    elements.stopMicrophone.disabled = true;
  }
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  elements.errors.textContent += `${message}\n`;
}

function sendJson(message) {
  if (socket?.readyState !== WebSocket.OPEN) {
    showError("The WebSocket is not connected.");
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function connect() {
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  elements.errors.textContent = "";
  setStatus("Connecting…", "connecting");
  elements.connect.disabled = true;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(
    `${protocol}//${window.location.host}/v1/voice`,
  );
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    setStatus("Starting session…", "connecting");
    elements.disconnect.disabled = false;
    sendJson({
      type: "session.start",
      requestId: crypto.randomUUID(),
      instructions: "You are a helpful voice assistant.",
    });
  });

  socket.addEventListener("message", async (event) => {
    try {
      if (typeof event.data === "string") {
        handleServerEvent(JSON.parse(event.data));
      } else {
        await playPcm16(
          event.data instanceof ArrayBuffer
            ? event.data
            : await event.data.arrayBuffer(),
        );
      }
    } catch (error) {
      showError(error);
    }
  });

  socket.addEventListener("error", () => {
    showError("WebSocket connection error.");
    setStatus("Connection error", "error");
  });

  socket.addEventListener("close", () => {
    stopMicrophone(false);
    stopAssistantAudio();
    setConnectedControls(false);
    elements.connect.disabled = false;
    setStatus("Disconnected", "disconnected");
  });
}

function handleServerEvent(event) {
  switch (event.type) {
    case "session.created":
      setStatus("Connected", "connected");
      setConnectedControls(true);
      break;
    case "transcript.user.final":
      appendTranscript(elements.userTranscript, event.transcript);
      break;
    case "response.started":
      elements.assistantTranscript.textContent = "";
      break;
    case "transcript.agent.delta":
      elements.assistantTranscript.textContent += event.transcript;
      break;
    case "transcript.agent.final":
      elements.assistantTranscript.textContent = event.transcript;
      break;
    case "response.interrupted":
      stopAssistantAudio();
      break;
    case "error":
      showError(`${event.code}: ${event.message}`);
      if (!event.recoverable) {
        setStatus("Session error", "error");
      }
      break;
  }
}

function appendTranscript(output, transcript) {
  if (output.textContent !== "") {
    output.textContent += "\n";
  }
  output.textContent += transcript;
}

async function startMicrophone() {
  if (microphoneStream || socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    microphoneContext = new AudioContext();
    await microphoneContext.resume();
    microphoneSource =
      microphoneContext.createMediaStreamSource(microphoneStream);
    microphoneProcessor = microphoneContext.createScriptProcessor(4096, 1, 1);

    microphoneProcessor.onaudioprocess = (event) => {
      if (socket?.readyState !== WebSocket.OPEN) {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resample(input, microphoneContext.sampleRate);
      socket.send(float32ToPcm16(resampled));
    };

    // The zero-gain connection keeps the processor active without monitoring
    // the microphone through the speakers.
    const silentOutput = microphoneContext.createGain();
    silentOutput.gain.value = 0;
    microphoneSource.connect(microphoneProcessor);
    microphoneProcessor.connect(silentOutput);
    silentOutput.connect(microphoneContext.destination);

    elements.startMicrophone.disabled = true;
    elements.stopMicrophone.disabled = false;
  } catch (error) {
    showError(error);
    stopMicrophone(false);
  }
}

function stopMicrophone(commit = true) {
  const wasRecording = microphoneStream !== undefined;

  microphoneProcessor?.disconnect();
  microphoneSource?.disconnect();
  for (const track of microphoneStream?.getTracks() ?? []) {
    track.stop();
  }
  void microphoneContext?.close();

  microphoneProcessor = undefined;
  microphoneSource = undefined;
  microphoneStream = undefined;
  microphoneContext = undefined;

  const connected = socket?.readyState === WebSocket.OPEN;
  elements.startMicrophone.disabled = !connected;
  elements.stopMicrophone.disabled = true;

  if (commit && wasRecording && connected) {
    sendJson({ type: "input_audio.commit" });
  }
}

function resample(input, sourceRate) {
  if (sourceRate === AUDIO_SAMPLE_RATE) {
    return input;
  }

  const outputLength = Math.round(
    input.length * AUDIO_SAMPLE_RATE / sourceRate,
  );
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / AUDIO_SAMPLE_RATE;

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const before = Math.floor(position);
    const after = Math.min(before + 1, input.length - 1);
    const fraction = position - before;
    output[index] =
      input[before] * (1 - fraction) + input[after] * fraction;
  }
  return output;
}

function float32ToPcm16(input) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(
      index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return buffer;
}

async function playPcm16(arrayBuffer) {
  const sampleCount = Math.floor(arrayBuffer.byteLength / 2);
  if (sampleCount === 0) {
    return;
  }

  playbackContext ??= new AudioContext();
  await playbackContext.resume();

  const view = new DataView(arrayBuffer);
  const audioBuffer = playbackContext.createBuffer(
    1,
    sampleCount,
    AUDIO_SAMPLE_RATE,
  );
  const channel = audioBuffer.getChannelData(0);
  for (let index = 0; index < sampleCount; index += 1) {
    channel[index] = view.getInt16(index * 2, true) / 0x8000;
  }

  const source = playbackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(playbackContext.destination);
  source.addEventListener("ended", () => playingSources.delete(source));
  playingSources.add(source);

  playbackTime = Math.max(playbackTime, playbackContext.currentTime + 0.02);
  source.start(playbackTime);
  playbackTime += audioBuffer.duration;
}

function stopAssistantAudio() {
  for (const source of playingSources) {
    try {
      source.stop();
    } catch {
      // A source that has already ended does not need further cleanup.
    }
  }
  playingSources.clear();
  playbackTime = playbackContext?.currentTime ?? 0;
}

function disconnect() {
  stopMicrophone(false);
  stopAssistantAudio();
  if (socket?.readyState === WebSocket.OPEN) {
    sendJson({ type: "session.end" });
    socket.close();
  } else if (socket?.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
}

elements.connect.addEventListener("click", connect);
elements.disconnect.addEventListener("click", disconnect);
elements.startMicrophone.addEventListener("click", startMicrophone);
elements.stopMicrophone.addEventListener("click", () => stopMicrophone(true));
elements.interrupt.addEventListener("click", () => {
  stopAssistantAudio();
  sendJson({ type: "response.interrupt" });
});
elements.textForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.textInput.value.trim();
  if (text !== "" && sendJson({ type: "input.text", text })) {
    elements.textInput.value = "";
  }
});
window.addEventListener("beforeunload", disconnect);
