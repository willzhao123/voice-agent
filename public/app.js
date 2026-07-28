const statusElement = document.querySelector("#status");
const recordButton = document.querySelector("#record");
const commitButton = document.querySelector("#commit");
const logElement = document.querySelector("#log");

const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

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

function toBase64(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return window.btoa(binary);
  });
}

socket.addEventListener("open", () => {
  statusElement.textContent = "Connected";
  recordButton.disabled = false;
  commitButton.disabled = false;
});

socket.addEventListener("message", (message) => {
  log(JSON.parse(message.data));
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
      send({
        type: "audio.append",
        audio: await toBase64(event.data),
      });
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
  send({ type: "audio.commit" });
});

window.addEventListener("beforeunload", () => {
  send({ type: "session.end" });
});
