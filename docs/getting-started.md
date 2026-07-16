# Getting started

## Purpose

Install Talking Assistant, configure its required services, and open a working local workspace.

## Use this guide when

- You are setting up the repository for the first time.
- You need the development or production startup sequence.
- The shell, preview, voice connection, or media tools do not start.

## Prerequisites

| Requirement | Why it is needed |
| --- | --- |
| Node.js 24+ and npm | Runs the React client, TypeScript server, tests, and builds |
| Docker Desktop, running | Builds the command sandbox and generated-workspace preview containers |
| Gemini API key | Enables Gemini Live and model-backed agents/media |
| Chrome or Edge | Powers browser inspection; WebGPU enables the rendered assistant head |
| Git on `PATH` | Maintains workspace history, branches, and agent worktrees |
| FFmpeg on `PATH`, or `FFMPEG_PATH` | Encodes and inspects generated audio/video/animation |

Docker is not required to display the last static release, but coding tasks cannot safely execute or publish a new preview without it.

## Environment setup

From the repository root:

```powershell
Copy-Item .env.example .env
npm install
```

Set at least this value in `.env`:

```dotenv
GEMINI_API_KEY=your-key-here
```

Keep `.env` local. It is ignored by Git and must not be copied into a generated workspace.

## Development startup

```powershell
npm run dev
```

This starts the TypeScript server in watch mode and the Vite client together.

| Surface | Default address |
| --- | --- |
| Vite development UI | `http://127.0.0.1:5173` |
| Application server/API | `http://127.0.0.1:3301` |
| Workspace preview gateway | `http://127.0.0.1:4174` |

Vite proxies `/api` and the preview path to the local server surfaces; use port `5173` for normal development.

## Production startup

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:3301`. Build before starting so the server can serve the current `dist/` client.

## Create the first workspace

On first startup, the workspace registry creates or migrates a default workspace. Open Assistant Settings to choose its rendering mode:

| Mode | Preview vision | Selection behavior |
| --- | --- | --- |
| DOM | Complete rendered page | DOM elements |
| Canvas | Primary `data-cowork-canvas-primary` canvas | Semantic layers through `window.coworkCanvas` |
| Mixed (default) | Complete rendered page | DOM elements or semantic canvas layers |

Use the Workspaces section to create, activate, duplicate, rename, or delete additional projects. Workspace data persists across restarts.

## Common setup failures

| Symptom | Check |
| --- | --- |
| Live connection reports no key | Confirm `GEMINI_API_KEY` is populated and restart the server |
| Coding or publish fails immediately | Start Docker Desktop and wait until `docker info` succeeds |
| Assistant head is absent or degraded | Use current Chrome/Edge and confirm WebGPU is enabled |
| Browser validation cannot launch | Ensure Chrome or Edge is installed in a discoverable location |
| Media encoding fails | Run `ffmpeg -version` or set `FFMPEG_PATH` to the executable |
| Port is already in use | Change `APP_PORT` and/or `PREVIEW_PORT`; if `APP_PORT` changes in development, update Vite's hard-coded API proxy target too |
| Production page is stale or missing | Run `npm run build` before `npm start` |
| Native package installation fails | Use Node.js 24+, remove only your local install artifacts if appropriate, and rerun `npm install` |

## Source of truth

- Commands and Node engine assumptions: [`package.json`](../package.json)
- Environment names and shipped defaults: [`.env.example`](../.env.example), [`src/server/config.ts`](../src/server/config.ts)
- Development proxy and port: [`vite.config.ts`](../vite.config.ts)
- Workspace initialization and preview behavior: [`WorkspaceRegistry.ts`](../src/server/workspace/WorkspaceRegistry.ts), [`WorkspaceManager.ts`](../src/server/workspace/WorkspaceManager.ts)

## Related documentation

- [Documentation index](README.md)
- [Project overview](../README.md)
- [Capabilities](capabilities.md)
- [Architecture](architecture.md)
- [Development and troubleshooting](development.md)
