# Capabilities

## Purpose

Describe the user-facing capabilities currently implemented by Talking Assistant and the prerequisites or limits attached to them.

## Use this guide when

- You are evaluating what the product can do.
- You are mapping an interface behavior to its implementation.
- You need to know whether a capability is automatic, optional, or configurable.

## Live conversation, voice, and vision

The floating assistant connects to Gemini Live through a server-side WebSocket proxy. The browser captures microphone PCM, receives audio and captions, and can stream sampled workspace frames. Vision is user-controlled and defaults to one balanced-quality frame per second when enabled; it is not continuously active by default merely because the app is open.

Assistant Settings control the Gemini voice, personality prompt, portrait-based face skinning, wire/skin blend, colors, animated backgrounds, particles, and visual effects. The shipped voice default is `Puck`.

## Visual selection

Selection turns spatial intent into implementation context:

- DOM selection records a stable selector, authored `data-cowork-id`, text, attributes, bounds, and nearby DOM.
- Canvas selection uses a semantic adapter exposed as `window.coworkCanvas`; the adapter supplies a primary canvas, hit testing, and layer lookup.
- The Live agent can retrieve the current selection and request a tightly cropped browser screenshot when appearance matters.
- Broader workspace screenshots are attached to delegated work only when requested by the Live flow.

Canvas mode requires one `data-cowork-canvas-primary` element and a compatible `window.coworkCanvas` adapter. DOM and Mixed modes stream the composited preview page.

## Direct edits and durable work

Direct file editing is enabled by default for small, localized changes. It applies atomic workspace edits and republishes the preview. Substantial or multi-file changes enter the durable work queue, where the system can coalesce duplicates, accept corrections or replacements, cancel by task ID, preserve progress events, and reconnect the UI after a refresh.

Planning is an explicit workflow: the Live agent does not start a planner solely because a task is complex. A requested plan is stored under `plans/`, can be edited and approved, and then becomes coding work with a visible todo list. See [Agent system](agent-system.md#workflows).

## Files and imports

Workspace Files can list, search, read, create, rename, copy, edit, and delete project files. It previews supported text, image, audio, and video content and lets users attach selected files as agent context.

Drag-and-drop imports store supported audio and other media under `uploads/`. Common raster formats are normalized to WebP under `uploads/images/`; these include AVIF, HEIC/HEIF, TIFF, BMP, JPEG XL, and ICO when the underlying decoder supports them. Images can also be added as layers in the separate raster Image Editor.

Other workspaces are isolated by default. An explicitly named workspace can receive a request-scoped, read-only grant for list/search/read operations; copying brings one requested file into the active workspace without modifying the source.

## Media creation and processing

When enabled in Workspace Settings, agent flows can create static images, video, transparent animation, music, and sound effects. Generative outputs are organized beneath `assets/generated/`; temporary media-job artifacts live beneath ignored `.cowork/media-jobs/` state. Animation output is a four-second, 48-frame, 12 FPS animated WebP, with an optional synchronized MP3 sidecar.

Deterministic tools can remove flat-color backgrounds and split sprite, symbol, icon, or object sheets. Their lossless WebP outputs are written beneath `assets/processed/` and remain available when model-backed media generation is disabled. FFmpeg is a prerequisite for video/audio processing. Generation also requires the relevant Gemini/Veo/Lyria model access.

## Workspaces and themes

Each workspace has an independent draft, immutable releases, settings, generated-media state, and bare Git repository. Users can create a mode-specific workspace, switch, duplicate, rename, or delete an inactive workspace. File-manager mutations publish a release and leave Git changes available for commit; close behavior is configurable as Ask (default), Always, or Never. Switching workspaces does not itself create a commit.

The shell includes built-in Dark and Light themes plus global custom themes. Theme controls cover surfaces, text contrast, accents, scale, density, corners, shadow, glow, blur, opacity, and lighting.

## Activity, recovery, and continuity

The Activity Center persists Live, direct-edit, planning, coding, media, preview, workspace, HTTP, and system events. From it, users can reconnect Live, cancel active work, restart the preview, restore the active release, or back up a draft and activate an earlier immutable release.

The SQLite work ledger recovers interrupted non-terminal work to the queue after a server restart. Refreshing the page reconnects to active work events and restores terminal history and todos. A completed plan awaiting approval remains discoverable in workspace state.

## Defaults and prerequisites

| Capability | Shipped default | Prerequisite or limit |
| --- | --- | --- |
| Workspace mode | Mixed | Canvas semantics require the canvas adapter |
| Vision sampling | 1 FPS, balanced | User enables vision and selects a share surface |
| Direct file edits | Enabled | Active workspace only |
| Dependency changes | Allowed | Docker; temporary install network access |
| Media generation | Enabled | API/model access; FFmpeg for encoded media |
| Validation | Standard | Docker and Chrome/Edge for full browser validation |
| Concurrent coding | 3 | Configurable from 1 to 8 |
| File-manager close commits | Ask | User choice at close |

## Source of truth

- Live client and vision: [`src/client/live`](../src/client/live), [`LiveProxy.ts`](../src/server/live/LiveProxy.ts)
- Selection bridge: [`selectionBridge.ts`](../src/server/workspace/selectionBridge.ts)
- Defaults: [`defaults.ts`](../src/client/settings/defaults.ts), [`assistantDefaults.ts`](../src/client/settings/assistantDefaults.ts)
- Workspace files, imports, and lifecycle: [`src/server/workspace`](../src/server/workspace)
- Media pipelines: [`src/server/media`](../src/server/media), [`AssetService.ts`](../src/server/workspace/AssetService.ts), [`ImageProcessingService.ts`](../src/server/workspace/ImageProcessingService.ts)

## Related documentation

- [Documentation index](README.md)
- [Project overview](../README.md)
- [Getting started](getting-started.md)
- [Architecture](architecture.md)
- [Agent system](agent-system.md)
