import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import mime from "mime-types";
import Valkey from "ioredis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectId = process.env.PROJECT_ID;

let valkey = null;
let valkeyConnected = false;

if (process.env.VALKEY_AIVEN_URI) {
  valkey = new Valkey(process.env.VALKEY_AIVEN_URI, {
    retryStrategy: (times) => {
      if (times > 10) {
        console.log("Valkey connection failed after 10 attempts. Continuing without logs.");
        return null;
      }
      const delay = Math.min(times * 500, 5000);
      console.log(`Valkey reconnection attempt ${times}, retrying in ${delay}ms...`);
      return delay;
    },
    connectTimeout: 10000,
    maxRetriesPerRequest: 3,
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
    console.error("Valkey connection error:", err.message);
    valkeyConnected = false;
  });

  valkey.on("close", () => {
    console.log("Valkey connection closed.");
    valkeyConnected = false;
  });
} else {
  console.log("Valkey URI not provided. Build will continue without real-time logs.");
}

async function publishLogs(log) {
  if (!valkey) return;

  try {
    await Promise.race([
      valkey.publish(`shipyard:logs:${projectId}`, JSON.stringify({ log })),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Publish timeout")), 2000)
      ),
    ]);
  } catch (error) {
    if (Math.random() < 0.1) {
      console.error("Valkey log publishing failed, continuing build...", error.message);
    }
  }
}

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function main() {
  console.log("\nShipyard build started.");
  publishLogs(`Build started for project: ${projectId}`);

  const codebasePath = path.join(__dirname, "codebase");
  const status = exec(`cd ${codebasePath} && npm install && npm run build`);

  status.stdout.on("data", (data) => {
    const output = data.toString();
    console.log("Build logs:\n", output);
    publishLogs(output);
  });

  status.stderr.on("data", (data) => {
    const output = data.toString();
    console.error("Build warnings:\n", output);
    publishLogs(output);
  });

  status.on("close", async (code) => {
    if (code !== 0) {
      const message = `Build failed with exit code ${code}. Deployment aborted.`;
      console.error(`\n${message}`);
      publishLogs(message);
      process.exit(1);
    }

    console.log("\nBuild complete.");
    console.log("\nStarting deployment to S3 bucket.");
    publishLogs("Build complete.");
    publishLogs("Starting deployment to S3 bucket.");

    const distFolderPath = path.join(__dirname, "codebase", "dist");

    try {
      const distFolderContents = fs.readdirSync(distFolderPath, {
        recursive: true,
      });

      console.log("\nPreparing files for parallel upload.");
      publishLogs("Preparing files for parallel upload.");

      const uploadPromises = [];
      for (const file of distFolderContents) {
        const itemPath = path.join(distFolderPath, file);
        if (fs.lstatSync(itemPath).isDirectory()) continue;

        const normalizedFile = file.replace(/\\/g, "/");
        const uploadParams = {
          Bucket: process.env.S3_BUCKET_NAME,
          Key: `builds/${projectId}/${normalizedFile}`,
          Body: fs.createReadStream(itemPath),
          ContentType: mime.lookup(itemPath) || "application/octet-stream",
        };

        console.log(`Queueing upload: ${normalizedFile}`);
        publishLogs(`Queueing upload: ${normalizedFile}`);
        uploadPromises.push(s3Client.send(new PutObjectCommand(uploadParams)));
      }

      await Promise.all(uploadPromises);

      const successMessage = `[${projectId}] Deployment successful. All files uploaded.`;
      console.log(`\n${successMessage}`);
      publishLogs(successMessage);
      process.exit(0);
    } catch (error) {
      console.error("\nAn error occurred during the upload process:", error);
      publishLogs(`An error occurred during the upload process: ${error.message}`);
      process.exit(1);
    }
  });
}

main();
