# Talking Assistant documentation

## Purpose

This index routes humans and coding agents to the smallest guide that answers a task.

## Use this guide when

- You are new to the repository.
- You need to find the authoritative guide for a change.
- You need to distinguish product behavior from implementation details.

## Task-based routes

| Task | Start here | Then verify in |
| --- | --- | --- |
| Install and run locally | [Getting started](getting-started.md) | [`package.json`](../package.json), [`.env.example`](../.env.example) |
| Evaluate user-facing features | [Capabilities](capabilities.md) | [`src/client`](../src/client), [`src/server`](../src/server) |
| Understand storage or data flow | [Architecture](architecture.md) | [`src/server/workspace`](../src/server/workspace), [`src/server/orchestration`](../src/server/orchestration) |
| Modify agents, tools, or routing | [Agent system](agent-system.md) | [`AgentConfigService.ts`](../src/server/agents/AgentConfigService.ts), [`ToolCatalog.ts`](../src/server/agents/ToolCatalog.ts) |
| Change application code | [Development](development.md) | [`src`](../src), repository tests |
| Troubleshoot a run | [Development: troubleshooting](development.md#troubleshooting) | Activity Center, server output, [`.cowork`](../.cowork) state |
| Recover a workspace | [Capabilities: recovery](capabilities.md#activity-recovery-and-continuity) | [`WorkspaceManager.ts`](../src/server/workspace/WorkspaceManager.ts) |
| Review safety boundaries | [Architecture: sandboxing](architecture.md#sandbox-and-trust-boundaries) | [`WorkspaceManager.ts`](../src/server/workspace/WorkspaceManager.ts), [`WorkspaceTools.ts`](../src/server/workspace/WorkspaceTools.ts) |

## Documentation conventions

- **Current behavior** describes what the checked-in source implements.
- **Default** means the value used when configuration does not override it.
- **Prerequisite** means the feature cannot operate fully without it.
- **Invariant** means a security or correctness rule that changes must preserve.
- Repository-relative links are included so agents can verify prose before editing code.

## Source of truth

Runtime code, tests, [`package.json`](../package.json), and [`.env.example`](../.env.example) are authoritative. Documentation explains them but does not override them. When behavior and prose differ, confirm the implementation and update the documentation with the code change.

## Related documentation

- [Project overview and quick start](../README.md)
- [Getting started](getting-started.md)
- [Capabilities](capabilities.md)
- [Architecture](architecture.md)
- [Agent system](agent-system.md)
- [Development](development.md)
