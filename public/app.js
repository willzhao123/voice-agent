const statusElement = document.querySelector("#status");
const recordButton = document.querySelector("#record");
const commitButton = document.querySelector("#commit");
const logElement = document.querySelector("#log");

const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(
  `${protocol}//${window.location.host}/v1/voice`,
);
socket.binaryType = "arraybuffer";

let mediaRecorder;

function log(event) {
  logElement.textContent += `${JSON.stringify(event)}\n`;
  logElement.scrollTop = logElement.scrollHeight;
}

function send(event) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

socket.addEventListener("open", () => {
  statusElement.textContent = "Connected";
  send({
    type: "session.start",
    requestId: crypto.randomUUID(),
    instructions: "You are a helpful voice assistant.",
  });
  recordButton.disabled = false;
  commitButton.disabled = false;
});

socket.addEventListener("message", (message) => {
  if (typeof message.data === "string") {
    log(JSON.parse(message.data));
  } else {
    log({
      type: "output_audio.binary",
      bytes: message.data.byteLength,
    });
  }
});

socket.addEventListener("close", () => {
  statusElement.textContent = "Disconnected";
  recordButton.disabled = true;
  commitButton.disabled = true;
});

recordButton.addEventListener("click", async () => {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    recordButton.textContent = "Start microphone";
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.addEventListener("dataavailable", async (event) => {
    if (event.data.size > 0) {
      socket.send(await event.data.arrayBuffer());
    }
  });
  mediaRecorder.addEventListener("stop", () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  });
  mediaRecorder.start(250);
  recordButton.textContent = "Stop microphone";
});

commitButton.addEventListener("click", () => {
  send({ type: "input_audio.commit" });
});

window.addEventListener("beforeunload", () => {
  send({ type: "session.end" });
});
