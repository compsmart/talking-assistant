import type { AgentStage, AgentToolCategoryDescriptor, AgentToolDescriptor } from '../../shared/protocol.js';

const ALL_STAGES: AgentStage[] = ['planner', 'researcher', 'coder', 'reviewer', 'resolver', 'media'];
const READ_STAGES: AgentStage[] = ['planner', 'researcher', 'coder', 'reviewer', 'resolver'];

export const TOOL_CATEGORIES: AgentToolCategoryDescriptor[] = [
  category('project-files', 'Project Files', 'Inspect and change files in the active workspace.', 10),
  category('references', 'References', 'Read user-authorized reference workspaces.', 20),
  category('coordination', 'Coordination', 'Maintain task state and orchestration.', 30),
  category('execution-quality', 'Execution & Quality', 'Run bounded commands and declared project checks.', 40),
  category('source-control', 'Source Control', 'Inspect Git history and changes without mutation.', 50),
  category('browser-ui', 'Browser & UI', 'Inspect or interact with workspace and public pages.', 60),
  category('web-research', 'Web & Research', 'Search and read unauthenticated public sources.', 70),
  category('data-documents', 'Data & Documents', 'Inspect structured data, databases, documents, and archives.', 80),
  category('media', 'Media', 'Generate, inspect, and process image, audio, and video assets.', 90),
  category('utilities', 'Utilities', 'Perform deterministic calculations and text operations.', 100),
];

const BUILTIN_TOOLS: AgentToolDescriptor[] = [
  descriptor('list_files', 'List files', 'Read the project file tree.', 'project-files', ['read'], READ_STAGES),
  descriptor('search_files', 'Search files', 'Search project filenames and contents.', 'project-files', ['read'], READ_STAGES),
  descriptor('locate_code', 'Locate code', 'Find contextual source excerpts.', 'project-files', ['read'], READ_STAGES),
  descriptor('read_files', 'Read files', 'Read project files by line range.', 'project-files', ['read'], READ_STAGES),
  descriptor('list_reference_files', 'List reference files', 'List an authorized reference workspace.', 'references', ['read'], READ_STAGES),
  descriptor('read_reference_file', 'Read reference file', 'Read an authorized reference workspace.', 'references', ['read'], READ_STAGES),
  descriptor('search_reference_files', 'Search reference files', 'Search an authorized reference workspace.', 'references', ['read'], READ_STAGES),
  descriptor('copy_reference_file', 'Copy reference file', 'Copy an authorized file into the active workspace.', 'references', ['read', 'write'], ['coder', 'resolver']),
  descriptor('create_todo_list', 'Create task list', 'Create the assignment checklist.', 'coordination', ['write'], ['coder', 'resolver']),
  descriptor('update_todo_list', 'Update task list', 'Update assignment progress.', 'coordination', ['write'], ['coder', 'resolver']),
  descriptor('apply_edits', 'Apply edits', 'Write or replace workspace files.', 'project-files', ['write'], ['coder', 'resolver']),
  descriptor('run_command', 'Run command', 'Run a sandboxed project command.', 'execution-quality', ['execute'], ['coder', 'resolver']),
  descriptor('install_dependencies', 'Install dependencies', 'Install project dependencies with registry access.', 'execution-quality', ['execute', 'network'], ['coder']),
  descriptor('inspect_preview', 'Inspect preview', 'Build and inspect the project in a browser.', 'browser-ui', ['execute'], ['coder', 'reviewer', 'resolver']),
  ...simpleTools('execution-quality', [
    ['project.run_tests', 'Run tests', 'Run only the declared package test script.'], ['project.run_build', 'Run build', 'Run only the declared package build script.'],
    ['project.run_typecheck', 'Run typecheck', 'Run only the declared package typecheck script.'], ['project.run_lint', 'Run lint', 'Run only the declared package lint script.'],
  ], ['execute'], ['coder', 'reviewer', 'resolver']),
  descriptor('package.lookup', 'Package lookup', 'Read package metadata from the public npm registry without installing.', 'execution-quality', ['read', 'network'], READ_STAGES),
  descriptor('workspace.http_request', 'Workspace HTTP request', 'Send a bounded HTTP request only to the active preview.', 'execution-quality', ['network', 'external_action'], ['coder', 'reviewer', 'resolver']),
  ...simpleTools('source-control', [['git.status', 'Git status', 'Read working-tree status.'], ['git.diff', 'Git diff', 'Read bounded working-tree differences.'], ['git.log', 'Git log', 'Read recent commit history.'], ['git.show', 'Git show', 'Read a commit or object.'], ['git.blame', 'Git blame', 'Read line attribution.']], ['read'], READ_STAGES),
  descriptor('browser.workspace_read', 'Workspace browser read', 'Navigate, snapshot, screenshot, and inspect the active preview.', 'browser-ui', ['read'], ['coder', 'reviewer', 'resolver']),
  descriptor('browser.workspace_interact', 'Workspace browser interact', 'Act on stable snapshot references in the active preview.', 'browser-ui', ['read', 'write'], ['coder', 'reviewer', 'resolver']),
  descriptor('browser.public_read', 'Public browser read', 'Read public pages in an isolated browser context.', 'browser-ui', ['read', 'network'], ALL_STAGES),
  descriptor('browser.public_interact', 'Public browser interact', 'Opt-in public form submission and external interaction.', 'browser-ui', ['read', 'network', 'external_action'], ALL_STAGES),
  descriptor('web.search', 'Web search', 'Ground a public-web answer with queries, sources, and inline citations.', 'web-research', ['read', 'network'], ALL_STAGES, ['gemini']),
  descriptor('web.read', 'Web read', 'Read up to five validated public HTTP(S) URLs as untrusted content.', 'web-research', ['read', 'network'], ALL_STAGES),
  ...simpleTools('data-documents', [['data.inspect', 'Inspect data', 'Inspect JSON, JSONL, CSV, TSV, or YAML structure.'], ['data.query', 'Query data', 'Filter and project bounded structured-data rows.'], ['sqlite.query', 'Query SQLite', 'Run a bounded read statement against an immutable workspace database.'], ['document.extract_text', 'Extract document text', 'Extract bounded text from PDF, DOCX, HTML, Markdown, or text.'], ['archive.inspect', 'Inspect archive', 'List ZIP members and read bounded text members without extraction.']], ['read'], READ_STAGES),
  ...simpleTools('media', [['image.inspect', 'Inspect image', 'Read image dimensions, format, channels, and metadata.'], ['image.compare', 'Compare images', 'Create a bounded visual comparison artifact.'], ['media.probe', 'Probe media', 'Inspect audio or video streams with FFprobe.'], ['media.extract_frame', 'Extract media frame', 'Create a task artifact from one video frame.']], ['read', 'execute'], ['researcher', 'coder', 'reviewer', 'resolver', 'media']),
  ...simpleTools('utilities', [['calculate', 'Calculate', 'Evaluate an allowlisted arithmetic expression without eval.'], ['datetime', 'Date and time', 'Parse, format, and calculate dates and times.'], ['regex.test', 'Test regular expression', 'Test a bounded regular expression in a disposable worker with a timeout.'], ['content.hash', 'Hash content', 'Compute a content digest with an allowlisted algorithm.']], ['read'], ALL_STAGES),
  mediaDescriptor('media.generate_image', 'Generate image', 'Generate an explicitly requested raster image asset through a persistent Media Agent job; never use this for a workspace HTML5 canvas change.', 'image', {
    prompt: textInput('Detailed creative brief'), name: textInput('Stable output filename stem'), transparent: { type: 'boolean' }, referenceImages: stringListInput('Workspace-relative reference images'), aspectRatio: aspectRatioInput(),
  }),
  mediaDescriptor('media.generate_video', 'Generate video', 'Generate a video through a persistent Media Agent job.', 'video', {
    prompt: textInput('Detailed creative and motion brief'), name: textInput('Stable output filename stem'), startFrame: textInput('Optional workspace-relative start frame'), endFrame: textInput('Optional workspace-relative end frame'), referenceImages: stringListInput('Workspace-relative reference images'), aspectRatio: aspectRatioInput(), soundEffects: textInput('Optional synchronized audio brief'),
  }),
  mediaDescriptor('media.generate_animation', 'Generate animation', 'Generate a transparent four-second animation through the persistent video-to-frames pipeline.', 'animation', {
    prompt: textInput('Detailed motion and timing brief'), name: textInput('Stable output filename stem'), startFrame: textInput('Required workspace-relative endpoint'), endFrame: textInput('Optional final endpoint; repeat the start frame for a seamless loop'), aspectRatio: aspectRatioInput(), soundEffects: textInput('Optional synchronized sound-effect brief'),
  }, ['prompt', 'name', 'startFrame']),
  mediaDescriptor('media.generate_music', 'Generate music', 'Generate music through a persistent Media Agent job.', 'music', {
    prompt: textInput('Detailed musical brief'), name: textInput('Stable output filename stem'), durationSeconds: numberInput('Requested duration'), musicTier: { type: 'string', enum: ['clip', 'pro'] },
  }),
  mediaDescriptor('media.generate_sound_effect', 'Generate sound effect', 'Generate a sound effect through a persistent Media Agent job.', 'sound-effect', {
    prompt: textInput('Detailed sound-effect brief'), name: textInput('Stable output filename stem'), durationSeconds: numberInput('Requested duration'),
  }),
  descriptor('remove_image_background', 'Remove image background', 'Process a workspace image.', 'media', ['write', 'execute'], ['coder', 'media']),
  descriptor('extract_image_regions', 'Extract image regions', 'Split foreground regions into assets.', 'media', ['write', 'execute'], ['coder', 'media']),
];

export interface EffectiveToolRequest {
  stage: AgentStage;
  profileToolIds: readonly string[];
  workspaceToolIds?: readonly string[];
  unavailableToolIds?: readonly string[];
}

export class ToolCatalog {
  private readonly values = new Map<string, AgentToolDescriptor>();

  constructor(tools: readonly AgentToolDescriptor[] = BUILTIN_TOOLS) {
    for (const value of tools) this.register(value);
  }

  register(value: AgentToolDescriptor) {
    if (!/^[a-z][a-z0-9_.-]*$/.test(value.id)) throw new Error(`Invalid tool ID: ${value.id}`);
    if (this.values.has(value.id)) throw new Error(`Tool is already registered: ${value.id}`);
    if (!TOOL_CATEGORIES.some((category) => category.id === value.categoryId)) throw new Error(`Unknown tool category: ${value.categoryId}`);
    if (value.inputSchema?.type !== 'object' || value.outputSchema?.type !== 'object') throw new Error(`Tool schemas must be object schemas: ${value.id}`);
    this.values.set(value.id, structuredClone(value));
  }

  list() { return [...this.values.values()].map((value) => structuredClone(value)); }
  categories() { return structuredClone(TOOL_CATEGORIES); }
  directory() { return { categories: this.categories(), tools: this.list() }; }
  get(id: string) { const value = this.values.get(id); return value ? structuredClone(value) : undefined; }

  effective(request: EffectiveToolRequest) {
    const workspace = request.workspaceToolIds ? new Set(request.workspaceToolIds) : undefined;
    const unavailable = new Set(request.unavailableToolIds || []);
    return request.profileToolIds.flatMap((id) => {
      const tool = this.values.get(id);
      return tool && tool.available && !unavailable.has(id) && (!workspace || workspace.has(id)) && tool.stages.includes(request.stage)
        ? [structuredClone(tool)] : [];
    });
  }
}

export const BUILTIN_AGENT_TOOLS = BUILTIN_TOOLS.map((value) => structuredClone(value));

function descriptor(id: string, name: string, description: string, categoryId: string, risks: AgentToolDescriptor['risks'], stages: AgentStage[], credentialSlots: string[] = []): AgentToolDescriptor {
  const sideEffectScope = risks.includes('external_action') ? 'external' : risks.some((risk) => risk === 'write' || risk === 'execute') ? 'workspace' : 'none';
  return { id, name, description, category: categoryId, categoryId, risks, stages, credentialSlots, available: true, sideEffectScope, runtimeCapability: id, inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: {} } };
}

function category(id: string, name: string, description: string, order: number): AgentToolCategoryDescriptor { return { id, name, description, order }; }
function simpleTools(categoryId: string, values: string[][], risks: AgentToolDescriptor['risks'], stages: AgentStage[]) { return values.map(([id, name, description]) => descriptor(id, name, description, categoryId, risks, stages)); }

function mediaDescriptor(id: string, name: string, description: string, kind: string, properties: Record<string, unknown>, required = ['prompt', 'name']): AgentToolDescriptor {
  return {
    ...descriptor(id, name, description, 'media', ['write', 'network'], ['coder', 'media']),
    runtimeToolId: 'delegate_media_task', fixedArguments: { kind },
    inputSchema: { type: 'object', properties, required },
  };
}
function textInput(description: string) { return { type: 'string', description }; }
function numberInput(description: string) { return { type: 'number', description }; }
function stringListInput(description: string) { return { type: 'array', description, items: { type: 'string' } }; }
function aspectRatioInput() { return { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] }; }

export { ALL_STAGES };
