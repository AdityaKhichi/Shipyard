# Shipyard

Shipyard is a self-hosted deployment system for static frontend projects. A user enters a Git repository URL and a project subdomain, Shipyard starts an isolated AWS ECS/Fargate build worker, uploads the generated `dist` files to S3, streams build logs back to the browser, and serves the deployed site through a reverse proxy using subdomain routing.

## Repository Map

```text
Shipyard/
  docker-compose.yaml                    # Runs frontend, API, and reverse proxy locally
  .env                                   # Runtime/build-time configuration
  shipyard-frontend/                     # React + Vite deployment console
  shipyard-api/                          # Express API + Socket.IO + ECS task launcher
  shipyard-build-image/codebase-build-server/
                                         # ECS/Fargate build worker image
  shipyard-reverse-proxy/                # Express reverse proxy for deployed projects
```

## High-Level Design

```text
Browser UI
  |
  | POST /deploy { PROJECT_ID, USER_GIT_REPOSITORY_URL }
  v
Shipyard API
  |
  | RunTaskCommand with env overrides
  v
AWS ECS/Fargate Build Task
  |
  | git clone -> npm install -> npm run build
  | upload dist files to s3://bucket/builds/{PROJECT_ID}/...
  | publish logs to Valkey channel shipyard:logs:{PROJECT_ID}
  v
S3 Bucket

Valkey/Redis log channel
  |
  v
Shipyard API Socket.IO server
  |
  | emits "log" to Socket.IO room {PROJECT_ID}
  v
Browser UI live logs

User visits http://{PROJECT_ID}.{domain}
  |
  v
Reverse Proxy
  |
  | proxies to https://{bucket}.s3.{region}.amazonaws.com/builds/{PROJECT_ID}
  v
S3 static assets
```

## Core Runtime Flow

### 1. User Starts a Deployment

The React app in `shipyard-frontend/src/App.jsx` collects:

- `repoUrl`: a GitHub or GitLab repository URL.
- `projectName`: the desired subdomain/project id.

Validation is done in `shipyard-frontend/src/utils.js`:

- Repository URL must match GitHub or GitLab style URLs.
- Project name must be lowercase letters, numbers, and hyphens, between 3 and 63 characters.

When the user clicks deploy, `deployRepository()` in `shipyard-frontend/src/main-server-api.js` sends:

```json
{
  "USER_GIT_REPOSITORY_URL": "https://github.com/user/repo.git",
  "PROJECT_ID": "my-site"
}
```

to:

```text
POST {VITE_API_URL}/deploy
```

### 2. API Starts the Build Task

`shipyard-api/server.js` exposes:

- `GET /`: health check text response.
- `POST /deploy`: starts the deployment.
- Socket.IO server: streams logs to frontend clients.

For `POST /deploy`, the API:

1. Reads `PROJECT_ID` and `USER_GIT_REPOSITORY_URL`.
2. Validates that both are present.
3. Creates an AWS ECS `RunTaskCommand`.
4. Starts one Fargate task using `ECS_CLUSTER_NAME`, `ECS_TASK_DEFINITION`, subnets, and security group from environment variables.
5. Passes deployment-specific values to the build container through ECS container overrides.

Important container override values:

```text
PROJECT_ID
USER_GIT_REPOSITORY_URL
S3_BUCKET_NAME
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
VALKEY_AIVEN_URI
```

The API immediately returns:

```json
{
  "message": "Deployment started successfully",
  "projectId": "my-site",
  "taskArn": "arn:aws:ecs:..."
}
```

At this point the build is asynchronous. The API does not wait for the ECS task to finish.

### 3. Frontend Joins the Log Room

After the API accepts the deployment, the frontend calls `listenToLogs(projectId, callback)` from `shipyard-frontend/src/socket.js`.

The Socket.IO client connects to:

```text
VITE_SOCKET_URL
```

and emits:

```text
joinRoom(projectId)
```

The API receives this in `io.on("connection")`, then calls:

```js
socket.join(projectId);
```

This means only clients watching `my-site` receive logs for `my-site`.

### 4. Build Image Clones and Builds the User Repository

The build worker lives in:

```text
shipyard-build-image/codebase-build-server/
```

The Docker image starts with:

```text
ENTRYPOINT [ "/home/app/main.sh" ]
```

`main.sh` does two things:

1. Reads `USER_GIT_REPOSITORY_URL`.
2. Runs:

```bash
git clone "$GIT_REPOSITORY_URL" /home/app/codebase
node script.js
```

`script.js` then runs:

```bash
cd /home/app/codebase && npm install && npm run build
```

This assumes the user project:

- Is a Node.js project.
- Has a valid `package.json`.
- Has a `build` script.
- Produces static output in a `dist` directory.

### 5. Build Logs Are Published Through Valkey

During the build, `script.js` listens to both `stdout` and `stderr` from the child process. Every output chunk is:

1. Printed to the build container logs.
2. Published to Valkey/Redis on:

```text
shipyard:logs:{PROJECT_ID}
```

The payload format is:

```json
{
  "log": "build output here"
}
```

The API subscribes to:

```text
shipyard:logs:*
```

When the API receives a Valkey message, it extracts the project id from the channel name and emits:

```text
Socket.IO event: log
Room: {PROJECT_ID}
Message: original Valkey message
```

The frontend parses this message in `normalizeLogMessage()`.

### 6. Build Output Is Uploaded to S3

After `npm run build` exits successfully, the build worker reads:

```text
/home/app/codebase/dist
```

It recursively uploads every file to:

```text
s3://{S3_BUCKET_NAME}/builds/{PROJECT_ID}/{file-path}
```

Examples:

```text
dist/index.html        -> s3://bucket/builds/my-site/index.html
dist/assets/app.js     -> s3://bucket/builds/my-site/assets/app.js
dist/assets/style.css  -> s3://bucket/builds/my-site/assets/style.css
```

The uploader sets `ContentType` using the `mime-types` package so browsers receive the correct MIME type for HTML, CSS, JavaScript, images, fonts, and other assets.

When all uploads finish, the build worker publishes:

```text
[my-site] Deployment successful. All files uploaded.
```

The frontend treats a log containing `Deployment successful` as the success signal and creates the live URL:

```text
http://{PROJECT_ID}.{VITE_CURRENT_DOMAIN}
```

## Reverse Proxy Flow

The reverse proxy solves the asset path problem caused by storing many projects inside one S3 bucket.

Browser request:

```text
http://my-site.example.com/assets/index-abc123.js
```

Reverse proxy behavior in `shipyard-reverse-proxy/server.js`:

1. Reads `req.hostname`.
2. Takes the first hostname segment as the project id:

```text
my-site.example.com -> my-site
```

3. Builds the S3 target:

```text
https://{S3_BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/builds/my-site
```

4. Proxies the original request path to that target.

Final upstream request:

```text
https://{bucket}.s3.{region}.amazonaws.com/builds/my-site/assets/index-abc123.js
```

For the root request `/`, the proxy appends `index.html`, so:

```text
http://my-site.example.com/
```

maps to:

```text
https://{bucket}.s3.{region}.amazonaws.com/builds/my-site/index.html
```

This lets deployed apps reference assets from `/assets/...` while still being stored under `builds/{PROJECT_ID}/...` in S3.

## Low-Level Design

### Frontend

Main files:

- `shipyard-frontend/src/App.jsx`
- `shipyard-frontend/src/main-server-api.js`
- `shipyard-frontend/src/socket.js`
- `shipyard-frontend/src/env.js`
- `shipyard-frontend/src/utils.js`

Responsibilities:

- Render deployment form, progress state, live logs, and deployment history.
- Validate repository URL and project subdomain before enabling deploy.
- Send deployment request to the API.
- Connect to Socket.IO and join project-specific log room.
- Convert a successful deployment log into a live URL.

Important environment values:

```text
VITE_API_URL
VITE_SOCKET_URL
VITE_CURRENT_DOMAIN
```

Because this is Vite, these values are embedded at frontend build time. In Docker, `docker-compose.yaml` passes them as build args to `shipyard-frontend/Dockerfile`.

### API

Main file:

```text
shipyard-api/server.js
```

Responsibilities:

- Accept deployment requests.
- Start ECS/Fargate tasks.
- Pass all required build-time configuration to the build container.
- Subscribe to Valkey logs.
- Forward logs to connected frontend clients through Socket.IO.

Important environment values:

```text
PORT
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
S3_BUCKET_NAME
ECS_CLUSTER_NAME
ECS_TASK_DEFINITION
ECS_CLUSTER_SUBNETS_1
ECS_CLUSTER_SUBNETS_2
ECS_CLUSTER_SUBNETS_3
ECS_CLUSTER_SECURITY_GROUP
ECS_CONTAINER_NAME
VALKEY_AIVEN_URI
FRONTEND_URL
```

### Build Worker Image

Main files:

- `shipyard-build-image/codebase-build-server/Dockerfile`
- `shipyard-build-image/codebase-build-server/main.sh`
- `shipyard-build-image/codebase-build-server/script.js`

Responsibilities:

- Clone the user repository.
- Install dependencies.
- Run the build command.
- Stream build logs to Valkey.
- Upload built files to S3.

Required input environment:

```text
PROJECT_ID
USER_GIT_REPOSITORY_URL
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
S3_BUCKET_NAME
VALKEY_AIVEN_URI
```

Expected output:

```text
s3://{S3_BUCKET_NAME}/builds/{PROJECT_ID}/index.html
s3://{S3_BUCKET_NAME}/builds/{PROJECT_ID}/assets/...
```

### Reverse Proxy

Main file:

```text
shipyard-reverse-proxy/server.js
```

Responsibilities:

- Receive requests for deployed apps.
- Extract project id from subdomain.
- Proxy requests to the matching S3 prefix.
- Convert `/` to `/index.html`.

Important environment values:

```text
REVERSE_PROXY_PORT
S3_BUCKET_NAME
AWS_REGION
```

## Docker Compose Flow

`docker-compose.yaml` runs three long-lived services:

```text
frontend       -> http://localhost:3000
backend        -> http://localhost:4571
reverse-proxy  -> http://localhost:80
```

The build worker is not started by the root compose file. It is expected to be built, pushed to a registry, referenced in an AWS ECS task definition, and launched on demand by the API.

## Required Infrastructure

### AWS S3

You need one S3 bucket to store built project files.

The build worker uploads to:

```text
builds/{PROJECT_ID}/...
```

The reverse proxy reads from:

```text
https://{S3_BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/builds/{PROJECT_ID}/...
```

For the current proxy implementation, objects must be publicly readable or otherwise accessible by the proxy. The sample bucket policy is in:

```text
shipyard-build-image/codebase-build-server/s3-bucket-policy-ToPublic.json
```

Update the bucket ARN before using it if your bucket name is not `shipyard-bucket`.

### AWS ECS/Fargate

You need:

- ECS cluster.
- Fargate task definition that points to the build worker image.
- Container name matching `ECS_CONTAINER_NAME`.
- Subnets that allow the task to reach GitHub/GitLab, npm, S3, and Valkey.
- Security group allowing outbound network access.

### Valkey/Redis

Valkey is used only for real-time logs. Deployments can still run without it, but the UI will not receive true live build logs.

Expected URI:

```text
redis://username:password@host:port
```

or the TLS-compatible URI your Valkey provider requires.

## Local Development

### Run the Main App

Fill `.env`, then run:

```bash
docker compose up --build
```

Open:

```text
http://localhost:3000
```

For local subdomain testing, set `VITE_CURRENT_DOMAIN` to a domain that resolves wildcard subdomains to your machine. `localhost` does not reliably support arbitrary subdomains in every browser and OS setup. A practical development option is to use a DNS name such as:

```text
127.0.0.1.nip.io
```

Then a project like `my-site` becomes:

```text
http://my-site.127.0.0.1.nip.io
```

pointing to the reverse proxy on port 80.

### Run the Build Worker Locally

From:

```text
shipyard-build-image/codebase-build-server/
```

provide the required environment variables and run:

```bash
docker compose up --build
```

This is useful for testing clone/build/upload independently from ECS.

## Environment Reference

Root `.env`:

```env
# Backend
PORT=4571
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
S3_BUCKET_NAME=
ECS_CLUSTER_NAME=
ECS_TASK_DEFINITION=
ECS_CLUSTER_SUBNETS_1=
ECS_CLUSTER_SUBNETS_2=
ECS_CLUSTER_SUBNETS_3=
ECS_CLUSTER_SECURITY_GROUP=
ECS_CONTAINER_NAME=shipyard-build-server-img
VALKEY_AIVEN_URI=
FRONTEND_URL=http://localhost:3000

# Frontend build args
VITE_API_URL=http://localhost:4571
VITE_SOCKET_URL=http://localhost:4571
VITE_CURRENT_DOMAIN=127.0.0.1.nip.io

# Reverse proxy
REVERSE_PROXY_PORT=80
```

## Deployment Checklist

1. Build and push the build worker image to a container registry.
2. Create or update the ECS task definition to use that image.
3. Set `ECS_CONTAINER_NAME` to the exact container name in the task definition.
4. Create an S3 bucket and allow writes from the build worker credentials.
5. Allow reads from the reverse proxy path, either with public object reads or another access strategy.
6. Configure Valkey and set `VALKEY_AIVEN_URI` in both API and build worker environments.
7. Point wildcard DNS for deployed apps to the reverse proxy host.
8. Set frontend build args so the browser uses the public API/socket URLs and the correct deployed-app domain.
9. Run the frontend, backend, and reverse proxy services.
10. Deploy a known small Vite app and verify S3 objects, logs, and reverse proxy serving.

