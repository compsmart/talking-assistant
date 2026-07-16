FROM node:24-alpine

RUN apk add --no-cache file fontconfig ttf-dejavu

# Workspace media scripts may use Sharp before a project-local npm install has
# run. Keep a sandbox-owned copy available as a fallback without overriding a
# version explicitly installed by the workspace.
WORKDIR /opt/cowork-runtime
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund sharp@0.35.3
COPY register-default-dependencies.mjs ./
ENV NODE_OPTIONS="--import=/opt/cowork-runtime/register-default-dependencies.mjs"
WORKDIR /workspace
