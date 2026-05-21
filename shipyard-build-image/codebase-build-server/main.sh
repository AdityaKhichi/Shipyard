#!/bin/bash

# GIT_REPOSITORY_URL is provided by the Shipyard API as an environment variable.
export GIT_REPOSITORY_URL="$USER_GIT_REPOSITORY_URL"

echo "USER_GIT_REPOSITORY_URL: $USER_GIT_REPOSITORY_URL"

git clone "$GIT_REPOSITORY_URL" /home/app/codebase

exec node script.js

