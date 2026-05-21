require("dotenv").config();

const express = require("express");
const http = require("http");
const { ECSClient, RunTaskCommand } = require("@aws-sdk/client-ecs");
const { Server } = require("socket.io");
const Valkey = require("ioredis");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 4571;

app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
    credentials: true,
  })
);

const ecsClient = new ECSClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const arnConfig = {
  cluster: process.env.ECS_CLUSTER_NAME,
  taskDefinition: process.env.ECS_TASK_DEFINITION,
};

if (!process.env.VALKEY_AIVEN_URI) {
  console.error("Valkey/Redis URI is not defined. Real-time logs will not be available.");
}

let valkey = null;
let valkeyConnected = false;

if (process.env.VALKEY_AIVEN_URI) {
  valkey = new Valkey(process.env.VALKEY_AIVEN_URI, {
    retryStrategy: (times) => {
      const delay = Math.min(times * 1000, 30000);
      console.log(`Valkey reconnection attempt ${times}, retrying in ${delay}ms...`);
      return delay;
    },
    maxRetriesPerRequest: null,
  });

  valkey.on("connect", () => {
    console.log("Connected to Valkey/Redis successfully.");
    valkeyConnected = true;
  });

  valkey.on("ready", () => {
    console.log("Valkey/Redis is ready.");
    valkeyConnected = true;
  });

  valkey.on("error", (err) => {
    console.error("Valkey/Redis connection error:", err.message);
    valkeyConnected = false;
  });

  valkey.on("close", () => {
    console.log("Valkey/Redis connection closed. Will retry.");
    valkeyConnected = false;
  });
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    credentials: true,
  },
});

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("joinRoom", (projectId) => {
    socket.join(projectId);
    console.log(`Socket ${socket.id} joined room: ${projectId}`);
    socket.emit("roomJoined", `Successfully joined room ${projectId}`);
  });
});

app.get("/", (req, res) => {
  res.send("Shipyard API is running.");
});

app.post("/deploy", async (req, res) => {
  const { PROJECT_ID, USER_GIT_REPOSITORY_URL } = req.body;

  if (!PROJECT_ID || !USER_GIT_REPOSITORY_URL) {
    return res
      .status(400)
      .json({ error: "PROJECT_ID and USER_GIT_REPOSITORY_URL are required." });
  }

  const command = new RunTaskCommand({
    cluster: arnConfig.cluster,
    taskDefinition: arnConfig.taskDefinition,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: [
          process.env.ECS_CLUSTER_SUBNETS_1,
          process.env.ECS_CLUSTER_SUBNETS_2,
          process.env.ECS_CLUSTER_SUBNETS_3,
        ],
        securityGroups: [process.env.ECS_CLUSTER_SECURITY_GROUP],
        assignPublicIp: "ENABLED",
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: process.env.ECS_CONTAINER_NAME || "shipyard-build-server-img",
          environment: [
            { name: "PROJECT_ID", value: PROJECT_ID },
            { name: "USER_GIT_REPOSITORY_URL", value: USER_GIT_REPOSITORY_URL },
            { name: "S3_BUCKET_NAME", value: process.env.S3_BUCKET_NAME },
            { name: "AWS_REGION", value: process.env.AWS_REGION },
            { name: "AWS_ACCESS_KEY_ID", value: process.env.AWS_ACCESS_KEY_ID },
            {
              name: "AWS_SECRET_ACCESS_KEY",
              value: process.env.AWS_SECRET_ACCESS_KEY,
            },
            { name: "VALKEY_AIVEN_URI", value: process.env.VALKEY_AIVEN_URI },
          ],
        },
      ],
    },
  });

  try {
    const data = await ecsClient.send(command);
    const taskArn = data.tasks?.[0]?.taskArn;
    console.log("Shipyard build task started:", taskArn);
    res.status(200).json({
      message: "Deployment started successfully",
      projectId: PROJECT_ID,
      taskArn,
    });
  } catch (error) {
    console.error("Error starting ECS task:", error);
    res.status(500).json({ error: "Failed to start deployment task." });
  }
});

async function initValkeySubscriber() {
  if (!valkey) {
    console.log("Valkey not configured. Real-time logs will not be available.");
    return;
  }

  try {
    await valkey.psubscribe("shipyard:logs:*");

    valkey.on("pmessage", (pattern, channel, message) => {
      console.log(`Received message from [${channel}]`);
      const projectId = channel.split(":")[2];

      if (projectId) {
        io.to(projectId).emit("log", message);
        console.log(`Log for project ${projectId}: ${message}`);
      }
    });
  } catch (error) {
    console.error("Failed to subscribe to Valkey channels:", error.message);
    console.log("Will retry when connection is established.");
    setTimeout(initValkeySubscriber, 5000);
  }
}

server.listen(port, () => {
  console.log(`Shipyard API with Socket.IO is running on http://localhost:${port}`);

  if (valkey) {
    initValkeySubscriber().catch((error) => {
      console.error("Failed to initialize Valkey subscriber:", error.message);
      console.log("Server will continue running. Real-time logs may be delayed.");
    });
  } else {
    console.log("Valkey not configured. Deployments will work but logs will not be real-time.");
  }
});
