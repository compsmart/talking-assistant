# Talking Assistant

**Talk to your workspace. Show it what you mean. Ship validated changes.**

Talking Assistant is a local-first, multimodal development workspace for AI builders and self-hosters. Speak or type to Gemini Live, share the rendered project, select the exact DOM element or canvas layer you mean, and hand substantial work to durable planning, coding, and media workflows.

![Talking Assistant interface with the live assistant, workspace preview, and conversation controls](./screenshot.png)

## Why Talking Assistant

- **Live voice and vision** — converse through Gemini Live while optionally streaming the rendered workspace.
- **Point at the problem** — select a DOM element or semantic canvas layer and attach precise visual and structural context.
- **Edit at the right scale** — make focused file edits directly or delegate multi-file work to durable agents.
- **Run work concurrently** — queue durable tasks, isolate coding attempts in Git worktrees, and integrate validated results serially.
- **Create media in context** — generate images, video, animation, music, and sound effects, or process existing raster assets.
- **Recover confidently** — reconnect to active runs, inspect persistent activity, restart previews, and restore immutable releases.
- **Configure the agent system** — tune profiles, routing, tools, skills, context, workspace overrides, and secret grants.
- **Contain generated code** — execute workspace commands in resource-limited Docker containers with scoped mounts and controlled network access.

## How it works

1. Start a voice or text conversation and, when useful, share the workspace preview.
2. Select an element, canvas layer, or file to make the request concrete.
3. Talking Assistant applies a focused edit or routes durable work to an appropriate planning, coding, or media flow.
4. Coding attempts run in isolated Git worktrees; dependency installation, tests, builds, and browser checks validate changes.
5. Successful work is integrated into the workspace Git history and published as a new immutable release. Failed drafts remain recoverable without replacing the visible release.

## Requirements

- Node.js 24 or newer
- Docker Desktop, running, for generated-workspace commands and previews
- Chrome or Edge; WebGPU is required for the rendered assistant head
- A Gemini API key
- Git and FFmpeg on `PATH`, or `FFMPEG_PATH` configured for FFmpeg

## Quick start

```powershell
Copy-Item .env.example .env
# Set GEMINI_API_KEY in .env
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. For a production build:

```powershell
npm run build
npm start
```

Then open `http://127.0.0.1:3301`.

## Documentation

| Guide | Use it for |
| --- | --- |
| [Documentation index](docs/README.md) | Route a setup, development, agent, storage, or troubleshooting task |
| [Getting started](docs/getting-started.md) | Install prerequisites, configure the environment, and open a first workspace |
| [Capabilities](docs/capabilities.md) | Understand the live interface, selection, files, media, workspaces, and recovery |
| [Architecture](docs/architecture.md) | Trace client/server boundaries, orchestration, storage, Git, and sandboxing |
| [Agent system](docs/agent-system.md) | Configure roles, routing, tools, grants, secrets, concurrency, and retries |
| [Development](docs/development.md) | Navigate the source, change behavior, validate work, and troubleshoot the stack |

## Development checks

```powershell
npm run typecheck
npm test
npm run build
```

`npm run perf:targeted` runs the optional targeted-edit benchmark.

## Security model

Talking Assistant is designed for local, single-user operation; it is not a hardened multi-tenant service. The Gemini API key stays on the server, agent file tools are rooted to generated workspaces, and generated-project commands run in Docker with CPU, memory, and process limits. Ordinary command execution is network-isolated; dependency installation receives temporary network access. Preview containers use Docker bridge networking and bind an ephemeral preview port to loopback.

These controls reduce exposure but do not make untrusted code risk-free. The host process still manages local workspace state and invokes Docker, media providers receive content required for generation, and the HTTP API has no authentication layer. Run it on a trusted machine, keep it bound to loopback, review tool and secret grants, and do not expose it directly to an untrusted network. See [Architecture](docs/architecture.md#sandbox-and-trust-boundaries) and [Agent system](docs/agent-system.md#non-negotiable-permission-invariants).
