# Agent system

## Purpose

Document the built-in agent roles, routing inputs, tool and secret grants, workflows, concurrency, retries, and permission invariants.

## Use this guide when

- You are configuring or extending agent profiles.
- You are changing routing, tools, planning, coding, or media behavior.
- You need to review which permissions are defaults versus runtime invariants.

## Built-in roles

The configuration service seeds six protected built-in profiles. They can be configured but cannot be deleted or converted to custom profiles.

| Role | Primary responsibility | Default maximum concurrency |
| --- | --- | --- |
| Planner | Read-only implementation planning | 1 |
| Researcher | Read-only code, web, data, document, image, and media research | 1 |
| Coder | Workspace edits, commands, validation helpers, references, browser inspection, and media delegation | 3 |
| Reviewer | Read-only review plus project and browser checks | 1 |
| Resolver | Conflict/repair edits and checks | 1 |
| Media | Media generation, analysis, and deterministic image processing | 1 |

Custom profiles can select one or more of these stages and define a model, instructions, capabilities, priority, maximum concurrency from 1 to 8, tools, skills, contexts, secret grants, and routing rules.

## Routing

Routing first filters for enabled profiles that support the requested stage and required tools. It then considers explicit preference, priority, routing rules, semantic match, reliability, and current load. Available modes are:

| Mode | Behavior |
| --- | --- |
| `automatic` (default) | Select the highest scoring eligible profile; use tie handling when scores overlap |
| `priority_first` | Give configured priority stronger precedence |
| `ask_on_overlap` | Request a choice when eligible candidates are too close |

The default tie threshold is `5`. The configuration schema also persists semantic and reliability weights with defaults of `1`, but the current router uses fixed semantic and reliability contributions rather than applying those stored multipliers. The routing simulator can test a proposed assignment without starting work.

## Tool categories and grants

The catalog groups tools by capability rather than granting an unrestricted shell:

| Category | Examples |
| --- | --- |
| Workspace read | List, locate, search, and read files |
| Workspace mutation | Atomic edits, reference copy, todo updates |
| Commands and project checks | Sandboxed command, dependency install, test/build/typecheck/lint helpers |
| Git | Status, diff, log, show, blame |
| Browser and web | Workspace preview inspection, scoped interaction, public reads and search |
| Data and documents | Structured data inspection/query, SQLite query, text extraction, archive inspection |
| Image and media analysis | Image inspect/compare, media probe, frame extraction |
| Media generation | Image, video, animation, music, sound effects |
| Deterministic processing | Background removal and region extraction |
| Safe utilities | Bounded calculation, date/time, regex, and content hashing |

Every built-in and custom agent can also run checked-in user Node utilities beneath `scripts/`; this locked baseline capability cannot be removed by a workspace override. It is not a general shell grant: the runner accepts only workspace-relative `.js`, `.mjs`, or `.cjs` files under that directory, passes arguments literally, disables networking, drops Linux capabilities, prevents privilege escalation, uses a read-only container filesystem, enforces container CPU/memory/process/time/output limits, and does not mount host paths, the Docker socket, or credentials. Planner, researcher, and reviewer executions additionally receive a read-only workspace mount. Live media-script publication rejects changes outside `assets/generated` and `assets/processed`.

An effective tool set is the intersection of the tool catalog, profile grants, workspace overrides, stage support, workspace settings, and request-scoped reference access. Adding a tool to a profile does not bypass the broker or workspace policy.

## Skills, contexts, and workspace overrides

Agent skills add instructions, capabilities, required tools, required secret kinds, and optional context resources. Context can be global or bound to one workspace and can contain inline content or workspace file globs. Per-workspace overrides can enable or disable a profile and replace its tools, skills, contexts, secret grants, or priority for that workspace.

Configuration writes are revision-checked and persisted atomically. A stale editor receives a conflict instead of overwriting newer agent configuration.

## Secrets

Secret values are stored through the operating-system credential vault when available; `.cowork/agents/config.json` contains metadata and grants, not plaintext values. A secret has global or workspace scope, an exposure mode, eligible agent IDs, and optional tool IDs.

The schema represents tool bindings, credential slots, and grants, but the current workspace-tool execution path does not inject tool-only secret values. Model-readable credentials are currently exposed for explicit on-demand reads when secret metadata has `model_readable` exposure, names the selected agent, and matches global or workspace scope. Values disclosed this way are redacted from subsequent model summaries and tool activity. `secretGrantIds` and `allowModelRead` are persisted configuration fields but are not additional runtime gates in that read path today. If the system credential vault is unavailable, secret management is unavailable rather than falling back to plaintext files.

## Workflows

### Focused edit

Live has no workspace-mutation or task-lifecycle tools. It forwards the authoritative user turn through one idempotent Assistant handoff. When Assistant fast edits are enabled, the Assistant may send one clear, localized existing-file change to a restricted read/search/edit worker. The workspace change service rolls back unsafe or multi-file attempts, publishes successful edits, and records them in Activity Center without creating durable worker work.

### Durable coding

A substantial request enters the SQLite work ledger, is routed to an eligible coder, and runs asynchronously in an isolated Git worktree. The worker maintains a visible todo list, edits files, and can delegate explicit media requests. Independent validation installs dependencies when needed, runs project tests and build scripts, and performs a browser smoke test. Integration into workspace `main` is serialized.

### Planning

Planning starts only when explicitly requested or when a plan-first strategy is explicitly selected. The planner is read-only and saves Markdown under `plans/`. The user can edit and approve the plan; execution verifies the plan path/hash and creates coding work. Planning may pause at its interaction or timeout boundary and preserve its model interaction chain for continuation.

### Media

Media jobs are durable, cancellable, and revisioned. Standalone media generation and reference-guided image manipulation route directly to the Media Agent and publish only the requested asset. They do not authorize a coding task, an application edit, opening the Image Editor, or placing the result into a page or HTML5 canvas. When an implementation request explicitly includes both asset creation and placement, a coding agent may receive stable placeholder paths and integrate those exact paths while the Media Agent generates and validates the asset. Deterministic image-processing tools do not require generative media to be enabled.

## Concurrency, continuation, and retries

- Workspace coding concurrency defaults to `3` and is configurable from `1` to `8`; this is the worker-pool capacity used by orchestration.
- Profile-level concurrency further limits a selected profile. `MAX_PARALLEL_AGENTS` is parsed and clamped in server configuration, but the current worker pool does not use it to override the workspace setting.
- A temporary profile concurrency shortage leaves work queued and retries automatically; it does not create a `needs_input` question.
- Coding worktrees run concurrently, but integration is serialized per workspace.
- Exact or normalized semantic duplicates can return the existing active work item unless the caller explicitly forces a duplicate.
- Assistant handoffs are idempotent per workspace and user-turn ID. The Assistant sees active work before it may create, reuse, update, cancel, answer, or approve a task.
- Interrupted active work is placed back in the queue on server restart; its interrupted attempt is recorded as failed.
- Coding model loops are bounded to 60 interactions per attempt.
- Planning segments are bounded to 80 interactions and can continue with their saved interaction chain after a step limit or timeout.
- Validation failure can trigger up to three repair attempts. Conflicts or a concurrently advanced `main` cause retry/conflict handling without silently replacing current work.

## Non-negotiable permission invariants

- Planner, researcher, and reviewer profiles must remain non-mutating unless a deliberate product/security change updates both broker enforcement and documentation.
- Every tool call must be checked against the selected profile's effective grants and the tool's supported stage.
- Workspace references require an explicit request-scoped grant and remain read-only except for copying a selected file into the active workspace.
- Commands execute only in the generated workspace sandbox; generic commands receive no network.
- Dependency network access is restricted to the dedicated install operation and may be disabled with `existing-only`.
- Media generation and preview inspection respect Workspace Settings even if a profile contains those tool IDs.
- Secret scope, agent eligibility, tool binding, grants, and exposure mode must be enforced server-side before expanding secret capabilities; tool-only injection is not currently implemented.
- Mutations with side effects must remain serialized where required; read-only tool calls may be parallelized.
- Failed validation, merge, or publication must not advance the visible release.

## Source of truth

- Profiles and defaults: [`AgentConfigService.ts`](../src/server/agents/AgentConfigService.ts)
- Tool definitions and enforcement: [`ToolCatalog.ts`](../src/server/agents/ToolCatalog.ts), [`ToolBroker.ts`](../src/server/agents/ToolBroker.ts), [`WorkspaceTools.ts`](../src/server/workspace/WorkspaceTools.ts)
- Secrets: [`SecretVault.ts`](../src/server/agents/SecretVault.ts), [`AgentConfigService.ts`](../src/server/agents/AgentConfigService.ts)
- Routing: [`AgentRouter.ts`](../src/server/orchestration/AgentRouter.ts), [`AssistantCoordinator.ts`](../src/server/orchestration/AssistantCoordinator.ts)
- Planning and coding loops: [`src/server/agent`](../src/server/agent)
- Durable execution: [`src/server/orchestration`](../src/server/orchestration)

## Related documentation

- [Documentation index](README.md)
- [Project overview](../README.md)
- [Capabilities](capabilities.md)
- [Architecture](architecture.md)
- [Development](development.md)
