# Shipyard Build Server

Containerized build worker for Shipyard. It clones a Git repository, installs dependencies, runs the app build, uploads the generated `dist` assets to S3, and publishes live build logs through Valkey/Redis.

## Local Development

### Docker build

```bash
docker build -t shipyard-build-server-img .
```

### Docker Compose

```bash
docker-compose up --build
```

## Environment Variables

```env
PROJECT_ID=your-project-name
USER_GIT_REPOSITORY_URL=https://github.com/username/repo.git
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET_NAME=your-bucket-name
VALKEY_AIVEN_URI=redis://username:password@host:port
```

## ECR Push

```bash
docker tag shipyard-build-server-img:latest your-account.dkr.ecr.region.amazonaws.com/shipyard-build-server-img:latest
docker push your-account.dkr.ecr.region.amazonaws.com/shipyard-build-server-img:latest
```
