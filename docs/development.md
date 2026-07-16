# Development

## Purpose

Provide a source map, exact commands, configuration reference, common change recipes, validation expectations, and troubleshooting guidance for contributors and coding agents.

## Use this guide when

- You are modifying application behavior.
- You need to locate an implementation boundary or configuration default.
- You are deciding what validation a change requires.
- You are troubleshooting development, agent, preview, or media behavior.

## Repository source map

| Path | Responsibility |
| --- | --- |
| [`src/client/App.tsx`](../src/client/App.tsx) | Top-level React shell composition and client state |
| [`src/client/components`](../src/client/components) | Assistant, workspace, files, settings, work, activity, and media UI |
| [`src/client/live`](../src/client/live) | Live session, microphone, workspace/canvas vision, tool bridge |
| [`src/client/avatar`](../src/client/avatar) | Face renderer, audio/lip sync, portrait mapping, visual effects |
| [`src/server/index.ts`](../src/server/index.ts) | Service composition, local HTTP routes, and WebSocket upgrades |
| [`src/server/live`](../src/server/live) | Server-side Gemini Live proxy |
| [`src/server/agent`](../src/server/agent) | Planning/coding loops, plan storage, task compatibility layer |
| [`src/server/agents`](../src/server/agents) | Agent configuration, catalog, broker, and secret vault |
| [`src/server/orchestration`](../src/server/orchestration) | Durable ledger, routing, worker pool, Git worktrees, integration |
| [`src/server/workspace`](../src/server/workspace) | Registry, files, settings, tools, sandbox, previews, releases, recovery |
| [`src/server/media`](../src/server/media) | Durable media jobs and animation/audio/video pipeline |
| [`src/shared/protocol.ts`](../src/shared/protocol.ts) | Shared client/server contracts |
| [`docker`](../docker) | Generated workspace preview and command-sandbox images |
| [`scripts`](../scripts) | Optional development benchmarks |

## Commands

Run from the repository root.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start server and Vite client watchers |
| `npm run dev:server` | Start only the TypeScript server watcher |
| `npm run dev:client` | Start only Vite |
| `npm run typecheck` | Type-check both TypeScript projects |
| `npm test` | Run the Vitest suite once |
| `npm run build` | Type-check and build the production client |
| `npm start` | Run the TypeScript server, serving the existing `dist/` build |
| `npm run perf:targeted` | Run the optional targeted-edit benchmark |

## Configuration variables

All values are read from the server environment; `.env` is loaded at startup.

| Variable | Shipped default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | Empty | Required credential for Live and model-backed work |
| `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | Live conversation model |
| `GEMINI_CODER_MODEL` | `gemini-3.5-flash` | Default coding model |
| `GEMINI_PLANNER_MODEL` | `gemini-3.5-flash` | Planning model; runtime fallback is coder model |
| `GEMINI_ASSISTANT_MODEL` | `gemini-3.5-flash` | Routing/coordinator and assistant-stage model; fallback is coder model |
| `GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image` | Static image generation model |
| `GEMINI_VIDEO_MODEL` | `veo-3.1-generate-preview` | Video and animation source model |
| `GEMINI_MEDIA_AGENT_MODEL` | `gemini-3.5-flash` | Media agent model; fallback is coder model |
| `GEMINI_MUSIC_MODEL` | `lyria-realtime-exp` | Music generation model |
| `GEMINI_MEDIA_ANALYSIS_MODEL` | `gemini-3.1-flash-lite-preview` | Media analysis model |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg executable path |
| `MEDIA_GENERATION_TIMEOUT_MS` | `900000` | Media generation timeout |
| `TASK_TIMEOUT_MS` | `480000` | Task/model timeout boundary |
| `MAX_PARALLEL_AGENTS` | `3` | Parsed and clamped to 1–8 for compatibility; current orchestration capacity comes from Workspace Settings |
| `APP_PORT` | `3301` | Local application server port |
| `PREVIEW_PORT` | `4174` | Local workspace preview gateway port |

When changing a default, update [`.env.example`](../.env.example), [`config.ts`](../src/server/config.ts), relevant client defaults, tests, and these docs together.

## Change recipes

### Change a shell interface feature

Start in [`src/client/components`](../src/client/components) and trace its client API into [`src/server/index.ts`](../src/server/index.ts). Preserve shared types in [`protocol.ts`](../src/shared/protocol.ts). Add focused component or utility tests when logic can be isolated.

### Change Live tools or multimodal context

Update [`LiveClient.ts`](../src/client/live/LiveClient.ts), the corresponding server route, and its permission/settings filter together. Verify DOM, Canvas, and Mixed wording and behavior independently. Keep the Gemini key confined to [`LiveProxy.ts`](../src/server/live/LiveProxy.ts).

### Add or change an agent tool

Update the catalog, broker, relevant profile defaults, runtime executor, and tests. Declare supported stages and mutation/network/secret behavior explicitly. A profile grant alone must never make an unimplemented or stage-incompatible tool callable. See [Agent system](agent-system.md#tool-categories-and-grants).

### Change workspace storage or lifecycle

Start with [`WorkspaceRegistry.ts`](../src/server/workspace/WorkspaceRegistry.ts) and [`WorkspaceManager.ts`](../src/server/workspace/WorkspaceManager.ts). Account for existing catalogs, legacy migration, active/inactive workspaces, Git state, releases, failed backups, and cleanup. Add migration and path-boundary tests.

### Change durable orchestration

Trace [`WorkStore.ts`](../src/server/orchestration/WorkStore.ts), [`WorkOrchestrator.ts`](../src/server/orchestration/WorkOrchestrator.ts), the concurrent runner, and Git worktree service as one transaction boundary. Preserve idempotency, restart recovery, cancellation, serial integration, and event replay.

### Change media behavior

Separate generative provider changes from deterministic processing. Preserve stable output paths, job revisions, cancellation, manifest metadata, temporary-state cleanup, and encoded-output validation. Run media unit tests; full provider calls require credentials and model access.

## Validation expectations

Choose checks in proportion to the change, but the standard repository gate is:

```powershell
npm run typecheck
npm test
npm run build
```

Also run `git diff --check`. For documentation-only changes, verify every relative Markdown/image link and every named command/configuration value. For workspace or agent changes, run the nearest focused tests before the full suite. For preview behavior, exercise the relevant DOM/Canvas/Mixed mode with Docker and a supported browser.

Do not treat a successful TypeScript build as proof of sandbox, persistence, migration, cancellation, or permission correctness; those boundaries require focused tests.

## Security boundaries

Preserve these rules during development:

- Never expose `GEMINI_API_KEY`, vault values, `.env`, the host filesystem, or the Docker socket to browser or agent tools.
- Resolve and validate every workspace path beneath its authorized root.
- Keep normal commands network-isolated and dependency network access explicit.
- Enforce grants, stages, workspace settings, reference scopes, and secret exposure on the server.
- Keep the service loopback-bound unless authentication and a broader threat model are deliberately implemented.
- Never publish a candidate after failed validation or a failed atomic Git update.

See [Architecture: sandbox and trust boundaries](architecture.md#sandbox-and-trust-boundaries) and [Agent system: permission invariants](agent-system.md#non-negotiable-permission-invariants).

## Troubleshooting

| Problem | Evidence to inspect | Likely next action |
| --- | --- | --- |
| Client cannot reach server | Vite output, `/api/health`, `APP_PORT` | Start `npm run dev:server`; remove port conflict |
| Live cannot connect | Server activity, `GEMINI_API_KEY`, Live model name | Correct `.env`; restart server |
| Work appears stuck | Work Center attempt timeline, Activity Center, `.cowork/orchestration.sqlite` | Answer a pending question, continue a paused plan, cancel, or restart to requeue interrupted work |
| Coding command fails | Agent terminal output, Docker status, workspace settings | Start Docker; check dependency policy and sandbox-compatible command |
| Preview fails validation | Build/test output, browser smoke-test errors, preview logs | Fix generated project; do not bypass publication guards casually |
| Canvas selection is unavailable | Workspace mode, primary canvas marker, adapter methods | Provide `data-cowork-canvas-primary` and `window.coworkCanvas` methods |
| Workspace opens an older result | Active release, Git status, Activity Center recovery state | Restore the draft or activate the intended immutable release |
| Media job fails | Media job stages, model access, FFmpeg path, timeout | Verify model entitlement, `FFMPEG_PATH`, inputs, and timeout |
| Secret controls are unavailable | Server startup logs and OS credential vault support | Configure a supported system keyring; plaintext fallback is intentionally absent |
| Agent configuration save conflicts | Current configuration revision | Reload and reapply the edit against the latest revision |

## Source of truth

- Scripts and dependencies: [`package.json`](../package.json)
- Environment template and runtime parsing: [`.env.example`](../.env.example), [`config.ts`](../src/server/config.ts)
- Tests: colocated `*.test.ts` files under [`src`](../src)
- Runtime architecture: [`src/server/index.ts`](../src/server/index.ts)
- Shared interfaces: [`protocol.ts`](../src/shared/protocol.ts)

## Related documentation

- [Documentation index](README.md)
- [Project overview](../README.md)
- [Getting started](getting-started.md)
- [Capabilities](capabilities.md)
- [Architecture](architecture.md)
- [Agent system](agent-system.md)
