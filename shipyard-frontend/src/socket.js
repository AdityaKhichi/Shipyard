import { io } from "socket.io-client";
import { env } from "./env.js";

const socket = io(env.socketURL, {
  path: "/socket.io/",
  transports: ["websocket", "polling"],
});

let currentProjectId = null;
let currentCallback = null;

socket.on("connect", () => {
  console.log(`Connected to Shipyard API with socket ID: ${socket.id}`);

  if (currentProjectId) {
    joinProjectRoom(currentProjectId);
  }
});

socket.on("disconnect", () => {
  console.log("Disconnected from Shipyard API.");
});

socket.on("connect_error", (err) => {
  console.error("Socket connection error:", err.message);
});

socket.on("log", (logMessage) => {
  if (currentCallback) {
    currentCallback(logMessage);
  }
});

function joinProjectRoom(projectId) {
  socket.emit("joinRoom", projectId);
}

export function listenToLogs(projectId, onLogReceived) {
  currentProjectId = projectId;
  currentCallback = onLogReceived;

  if (socket.connected) {
    joinProjectRoom(projectId);
  }
}
