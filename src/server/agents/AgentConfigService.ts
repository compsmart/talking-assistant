import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentConfigurationSnapshot, AgentContextResource, AgentProfile, AgentSecretMetadata,
  AgentSkill, AgentWorkspaceOverride,
} from '../../shared/protocol.js';
import { config } from '../config.js';
import type { SecretVault } from './SecretVault.js';

const PROFILE_TOOLS = {
  planner: ['list_files', 'search_files', 'locate_code', 'read_files', 'list_reference_files', 'read_reference_file', 'search_reference_files', 'web.search', 'web.read', 'browser.public_read', 'package.lookup', 'git.status', 'git.diff', 'git.log', 'git.show', 'git.blame', 'data.inspect', 'data.query', 'sqlite.query', 'document.extract_text', 'archive.inspect', 'calculate', 'datetime', 'regex.test', 'content.hash'],
  researcher: ['list_files', 'search_files', 'locate_code', 'read_files', 'list_reference_files', 'read_reference_file', 'search_reference_files', 'web.search', 'web.read', 'browser.public_read', 'package.lookup', 'git.status', 'git.diff', 'git.log', 'git.show', 'git.blame', 'data.inspect', 'data.query', 'sqlite.query', 'document.extract_text', 'archive.inspect', 'image.inspect', 'image.compare', 'media.probe', 'media.extract_frame', 'calculate', 'datetime', 'regex.test', 'content.hash'],
  coder: ['list_files', 'search_files', 'locate_code', 'read_files', 'create_todo_list', 'update_todo_list', 'apply_edits', 'list_reference_files', 'read_reference_file', 'search_reference_files', 'copy_reference_file', 'run_command', 'install_dependencies', 'project.run_tests', 'project.run_build', 'project.run_typecheck', 'project.run_lint', 'package.lookup', 'workspace.http_request', 'git.status', 'git.diff', 'git.log', 'git.show', 'git.blame', 'inspect_preview', 'browser.workspace_read', 'browser.workspace_interact', 'browser.public_read', 'web.search', 'web.read', 'data.inspect', 'data.query', 'sqlite.query', 'document.extract_text', 'archive.inspect', 'image.inspect', 'image.compare', 'media.probe', 'media.extract_frame', 'calculate', 'datetime', 'regex.test', 'content.hash', 'media.generate_image', 'media.generate_video', 'media.generate_animation', 'media.generate_music', 'media.generate_sound_effect', 'remove_image_background', 'extract_image_regions'],
  reviewer: ['list_files', 'search_files', 'locate_code', 'read_files', 'list_reference_files', 'read_reference_file', 'search_reference_files', 'project.run_tests', 'project.run_build', 'project.run_typecheck', 'project.run_lint', 'workspace.http_request', 'git.status', 'git.diff', 'git.log', 'git.show', 'git.blame', 'inspect_preview', 'browser.workspace_read', 'browser.workspace_interact', 'browser.public_read', 'web.search', 'web.read', 'data.inspect', 'data.query', 'sqlite.query', 'document.extract_text', 'archive.inspect', 'image.inspect', 'image.compare', 'media.probe', 'media.extract_frame', 'calculate', 'datetime', 'regex.test', 'content.hash'],
  resolver: ['list_files', 'search_files', 'locate_code', 'read_files', 'create_todo_list', 'update_todo_list', 'apply_edits', 'run_command', 'project.run_tests', 'project.run_build', 'project.run_typecheck', 'project.run_lint', 'package.lookup', 'workspace.http_request', 'git.status', 'git.diff', 'git.log', 'git.show', 'git.blame', 'inspect_preview', 'browser.workspace_read', 'browser.workspace_interact', 'browser.public_read', 'web.search', 'web.read', 'data.inspect', 'data.query', 'sqlite.query', 'document.extract_text', 'archive.inspect', 'image.inspect', 'image.compare', 'media.probe', 'media.extract_frame', 'calculate', 'datetime', 'regex.test', 'content.hash', 'remove_image_background', 'extract_image_regions'],
  media: ['read_files', 'list_reference_files', 'read_reference_file', 'search_reference_files', 'web.search', 'web.read', 'browser.public_read', 'data.inspect', 'document.extract_text', 'image.inspect', 'image.compare', 'media.probe', 'media.extract_frame', 'calculate', 'datetime', 'content.hash', 'media.generate_image', 'media.generate_video', 'media.generate_animation', 'media.generate_music', 'media.generate_sound_effect', 'remove_image_background', 'extract_image_regions'],
} as const;

const SCOPED_MEDIA_TOOLS = ['media.generate_image', 'media.generate_video', 'media.generate_animation', 'media.generate_music', 'media.generate_sound_effect'];

export class AgentConfigService {
  private value: AgentConfigurationSnapshot = defaults();
  private readonly path: string;

  constructor(root = join(config.stateDir, 'agents'), private readonly vault?: SecretVault) {
    this.path = join(root, 'config.json');
  }

  async initialize() {
    const stored = await readFile(this.path, 'utf8').then(JSON.parse).catch(() => undefined);
    const migrated = stored ? migrateConfiguration(stored) : undefined;
    this.value = migrated ? validateAgentConfiguration(migrated) : defaults();
    if (!stored || JSON.stringify(stored) !== JSON.stringify(migrated)) await this.persist(this.value);
    return this.get();
  }

  get() { return structuredClone(this.value); }

  modelReadableSecrets(agentId: string, workspaceId: string) {
    return this.value.secrets.filter((secret) => secret.exposure === 'model_readable' && secret.agentIds.includes(agentId) && (secret.scope === 'global' || secret.workspaceId === workspaceId)).map(({ id, name, kind }) => ({ id, name, kind }));
  }

  async readModelSecret(secretId: string, agentId: string, workspaceId: string) {
    if (!this.vault) throw unavailable('Secret storage is not configured.');
    const secret = this.value.secrets.find((item) => item.id === secretId && item.exposure === 'model_readable' && item.agentIds.includes(agentId) && (item.scope === 'global' || item.workspaceId === workspaceId));
    if (!secret) throw statusError('That secret is not model-readable for this agent and workspace.', 403);
    return this.vault.read(secret.id);
  }

  async replace(input: unknown, expectedRevision: number) {
    this.assertRevision(expectedRevision);
    const next = validateAgentConfiguration(input);
    protectBuiltins(this.value, next);
    next.revision = this.value.revision + 1;
    await this.persist(next); this.value = next;
    return this.get();
  }

  async saveProfile(input: unknown, expectedRevision: number) {
    this.assertRevision(expectedRevision);
    const raw = input as Partial<AgentProfile>;
    const existing = raw?.id ? this.value.profiles.find((item) => item.id === raw.id) : undefined;
    if (existing?.kind === 'builtin' && raw.kind && raw.kind !== 'builtin') throw invalid('Built-in agent profiles cannot be converted to custom profiles.');
    const now = new Date().toISOString();
    const candidate = validateProfile({ ...raw, id: raw?.id || `agent-${randomUUID()}`, kind: existing?.kind || raw?.kind || 'custom', revision: (existing?.revision || 0) + 1, createdAt: existing?.createdAt || now, updatedAt: now });
    const profiles = this.value.profiles.filter((item) => item.id !== candidate.id).concat(candidate);
    return this.commit({ ...this.value, profiles }, expectedRevision);
  }

  async cloneProfile(id: string, expectedRevision: number) {
    const source = this.value.profiles.find((item) => item.id === id);
    if (!source) throw notFound(`Agent profile not found: ${id}`);
    const now = new Date().toISOString();
    return this.saveProfile({ ...source, id: `agent-${randomUUID()}`, name: `${source.name} copy`, kind: 'custom', revision: 0, createdAt: now, updatedAt: now }, expectedRevision);
  }

  async deleteProfile(id: string, expectedRevision: number) {
    this.assertRevision(expectedRevision);
    const profile = this.value.profiles.find((item) => item.id === id);
    if (!profile) throw notFound(`Agent profile not found: ${id}`);
    if (profile.kind === 'builtin') throw invalid('Built-in agent profiles cannot be deleted.');
    return this.commit({
      ...this.value,
      profiles: this.value.profiles.filter((item) => item.id !== id),
      overrides: this.value.overrides.filter((item) => item.agentId !== id),
      secretGrants: this.value.secretGrants.filter((item) => item.agentId !== id),
      secrets: this.value.secrets.map((item) => ({ ...item, agentIds: item.agentIds.filter((agentId) => agentId !== id) })),
    }, expectedRevision);
  }

  async saveSkill(input: unknown, expectedRevision: number) {
    const raw = input as Partial<AgentSkill>; const existing = raw?.id ? this.value.skills.find((item) => item.id === raw.id) : undefined; const now = new Date().toISOString();
    const candidate = validateSkill({ ...raw, id: raw?.id || `skill-${randomUUID()}`, revision: (existing?.revision || 0) + 1, createdAt: existing?.createdAt || now, updatedAt: now });
    return this.commit({ ...this.value, skills: this.value.skills.filter((item) => item.id !== candidate.id).concat(candidate) }, expectedRevision);
  }

  async saveContext(input: unknown, expectedRevision: number) {
    const raw = input as Partial<AgentContextResource>; const existing = raw?.id ? this.value.contexts.find((item) => item.id === raw.id) : undefined; const now = new Date().toISOString();
    const candidate = validateContext({ ...raw, id: raw?.id || `context-${randomUUID()}`, revision: (existing?.revision || 0) + 1, createdAt: existing?.createdAt || now, updatedAt: now });
    return this.commit({ ...this.value, contexts: this.value.contexts.filter((item) => item.id !== candidate.id).concat(candidate) }, expectedRevision);
  }

  async saveOverride(input: unknown, expectedRevision: number) {
    const raw = input as Partial<AgentWorkspaceOverride>; const existing = this.value.overrides.find((item) => item.agentId === raw?.agentId && item.workspaceId === raw?.workspaceId);
    const candidate = validateOverride({ ...raw, revision: (existing?.revision || 0) + 1, updatedAt: new Date().toISOString() });
    if (!this.value.profiles.some((item) => item.id === candidate.agentId)) throw invalid(`Unknown agent profile: ${candidate.agentId}`);
    return this.commit({ ...this.value, overrides: this.value.overrides.filter((item) => item.agentId !== candidate.agentId || item.workspaceId !== candidate.workspaceId).concat(candidate) }, expectedRevision);
  }

  async createSecret(metadata: unknown, value: string, expectedRevision: number) {
    if (!this.vault) throw unavailable('Secret storage is not configured.');
    this.assertRevision(expectedRevision);
    const now = new Date().toISOString(); const candidate = validateSecret({ ...(metadata as object), id: (metadata as any)?.id || `secret-${randomUUID()}`, createdAt: now, updatedAt: now });
    await this.vault.put(candidate, value);
    try { return await this.commit({ ...this.value, secrets: this.value.secrets.concat(candidate) }, expectedRevision); }
    catch (error) { await this.vault.delete(candidate.id).catch(() => false); throw error; }
  }

  async replaceSecret(id: string, value: string) {
    if (!this.vault) throw unavailable('Secret storage is not configured.');
    if (!this.value.secrets.some((item) => item.id === id)) throw notFound(`Secret metadata not found: ${id}`);
    await this.vault.put({ id }, value);
  }

  async deleteSecret(id: string, expectedRevision: number) {
    if (!this.vault) throw unavailable('Secret storage is not configured.');
    this.assertRevision(expectedRevision);
    await this.vault.delete(id);
    return this.commit({ ...this.value, secrets: this.value.secrets.filter((item) => item.id !== id), secretGrants: this.value.secretGrants.filter((item) => item.secretId !== id) }, expectedRevision);
  }

  private async commit(next: AgentConfigurationSnapshot, expectedRevision: number) {
    this.assertRevision(expectedRevision); next.revision = this.value.revision + 1;
    const validated = validateAgentConfiguration(next); await this.persist(validated); this.value = validated; return this.get();
  }

  private assertRevision(expected: number) { if (expected !== this.value.revision) throw conflict(`Agent configuration changed; expected revision ${expected}, current revision ${this.value.revision}.`); }
  private async persist(value: AgentConfigurationSnapshot) {
    await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, this.path);
  }
}

function migrateConfiguration(input: any) {
  const value = structuredClone(input);
  const expand = (ids: unknown) => Array.isArray(ids) && ids.includes('delegate_media_task')
    ? [...new Set(ids.flatMap((id) => id === 'delegate_media_task' ? SCOPED_MEDIA_TOOLS : [id]))]
    : ids;
  for (const profile of value.profiles || []) { profile.toolIds = expand(profile.toolIds); for (const rule of profile.routingRules || []) if (rule.requiredTools) rule.requiredTools = expand(rule.requiredTools); }
  for (const override of value.overrides || []) if (override.toolIds) override.toolIds = expand(override.toolIds);
  for (const skill of value.skills || []) skill.requiredToolIds = expand(skill.requiredToolIds);
  for (const secret of value.secrets || []) secret.toolIds = expand(secret.toolIds);
  value.secretGrants = (value.secretGrants || []).flatMap((grant: any) => grant.toolId === 'delegate_media_task'
    ? SCOPED_MEDIA_TOOLS.map((toolId, index) => ({ ...grant, id: index ? `${grant.id}.${toolId.slice('media.generate_'.length)}` : grant.id, toolId }))
    : [grant]);
  if (value.schemaVersion === 1) {
    for (const profile of value.profiles || []) {
      const stage = String(profile.id || '').replace('builtin-', '') as keyof typeof PROFILE_TOOLS;
      if (profile.kind === 'builtin' && PROFILE_TOOLS[stage]) profile.toolIds = [...PROFILE_TOOLS[stage]];
    }
    value.schemaVersion = 2;
  }
  return value;
}

export function validateAgentConfiguration(input: any): AgentConfigurationSnapshot {
  if (!input || typeof input !== 'object') throw invalid('Agent configuration must be an object.');
  if (input.schemaVersion !== 2) throw invalid('Unsupported agent configuration schema version.');
  const profiles = uniqueBy(array(input.profiles, 'profiles').map(validateProfile), 'agent profile');
  const skills = uniqueBy(array(input.skills, 'skills').map(validateSkill), 'skill');
  const contexts = uniqueBy(array(input.contexts, 'contexts').map(validateContext), 'context');
  const secrets = uniqueBy(array(input.secrets, 'secrets').map(validateSecret), 'secret');
  const overrides = array(input.overrides, 'overrides').map(validateOverride);
  const secretGrants = array(input.secretGrants, 'secret grants').map((item: any) => ({ id: id(item.id), secretId: id(item.secretId), agentId: id(item.agentId), ...(item.toolId ? { toolId: id(item.toolId) } : {}), ...(item.credentialSlot ? { credentialSlot: text(item.credentialSlot, 'credential slot', 100) } : {}), allowModelRead: boolean(item.allowModelRead, 'allow model read') }));
  const mode = oneOf(input.routing?.mode, ['automatic', 'priority_first', 'ask_on_overlap'], 'routing mode');
  return { schemaVersion: 2, revision: integer(input.revision, 0, Number.MAX_SAFE_INTEGER, 'configuration revision'), profiles, overrides, skills, contexts, secrets, secretGrants, routing: { mode, tieThreshold: number(input.routing?.tieThreshold, 0, 100, 'tie threshold'), semanticWeight: number(input.routing?.semanticWeight, 0, 2, 'semantic weight'), reliabilityWeight: number(input.routing?.reliabilityWeight, 0, 2, 'reliability weight') } };
}

function validateProfile(input: any): AgentProfile {
  const createdAt = date(input.createdAt, 'created at'); const updatedAt = date(input.updatedAt, 'updated at');
  return { id: id(input.id), name: text(input.name, 'agent name', 80), description: text(input.description ?? '', 'agent description', 500), kind: oneOf(input.kind, ['builtin', 'custom'], 'agent kind'), enabled: boolean(input.enabled, 'enabled'), stages: unique(array(input.stages, 'stages').map((value) => oneOf(value, ['planner', 'researcher', 'coder', 'reviewer', 'resolver', 'media'], 'agent stage'))), capabilities: stringList(input.capabilities, 'capabilities'), model: text(input.model, 'model', 120), instructions: text(input.instructions ?? '', 'instructions', 32_000), toolIds: ids(input.toolIds, 'tool IDs'), skillIds: ids(input.skillIds, 'skill IDs'), contextIds: ids(input.contextIds, 'context IDs'), secretGrantIds: ids(input.secretGrantIds, 'secret grant IDs'), priority: integer(input.priority, -50, 50, 'priority'), maxConcurrency: integer(input.maxConcurrency, 1, 8, 'maximum concurrency'), routingRules: array(input.routingRules, 'routing rules').map(validateRule), revision: integer(input.revision, 1, Number.MAX_SAFE_INTEGER, 'profile revision'), createdAt, updatedAt };
}
function validateRule(input: any) { return { id: id(input.id), name: text(input.name, 'rule name', 80), enabled: boolean(input.enabled, 'rule enabled'), effect: oneOf(input.effect, ['prefer', 'exclude'], 'rule effect'), weight: integer(input.weight, -100, 100, 'rule weight'), ...(input.stages ? { stages: unique(array(input.stages, 'rule stages').map((value) => oneOf(value, ['planner', 'researcher', 'coder', 'reviewer', 'resolver', 'media'], 'rule stage'))) } : {}), ...(input.capabilities ? { capabilities: stringList(input.capabilities, 'rule capabilities') } : {}), ...(input.keywords ? { keywords: stringList(input.keywords, 'rule keywords') } : {}), ...(input.fileGlobs ? { fileGlobs: stringList(input.fileGlobs, 'rule file globs') } : {}), ...(input.requiredTools ? { requiredTools: ids(input.requiredTools, 'required tools') } : {}), ...(input.examples ? { examples: stringList(input.examples, 'rule examples', 20, 1000) } : {}), ...(input.negativeExamples ? { negativeExamples: stringList(input.negativeExamples, 'negative examples', 20, 1000) } : {}) } as AgentProfile['routingRules'][number]; }
function validateSkill(input: any): AgentSkill { return { id: id(input.id), name: text(input.name, 'skill name', 80), description: text(input.description ?? '', 'skill description', 500), instructions: text(input.instructions ?? '', 'skill instructions', 32_000), capabilities: stringList(input.capabilities, 'skill capabilities'), requiredToolIds: ids(input.requiredToolIds, 'required tool IDs'), requiredSecretKinds: stringList(input.requiredSecretKinds, 'required secret kinds'), contextIds: ids(input.contextIds, 'skill context IDs'), enabled: boolean(input.enabled, 'skill enabled'), revision: integer(input.revision, 1, Number.MAX_SAFE_INTEGER, 'skill revision'), createdAt: date(input.createdAt, 'created at'), updatedAt: date(input.updatedAt, 'updated at') }; }
function validateContext(input: any): AgentContextResource { const scope = oneOf(input.scope, ['global', 'workspace'], 'context scope'); const content = input.content === undefined ? undefined : text(input.content, 'context content', 32_768); const fileGlobs = input.fileGlobs === undefined ? undefined : stringList(input.fileGlobs, 'context file globs', 50, 500); if (!content && !fileGlobs?.length) throw invalid('Context must include content or file globs.'); if (scope === 'workspace' && !input.workspaceId) throw invalid('Workspace context requires a workspace ID.'); return { id: id(input.id), name: text(input.name, 'context name', 80), description: text(input.description ?? '', 'context description', 500), scope, ...(input.workspaceId ? { workspaceId: id(input.workspaceId) } : {}), ...(content !== undefined ? { content } : {}), ...(fileGlobs ? { fileGlobs } : {}), enabled: boolean(input.enabled, 'context enabled'), revision: integer(input.revision, 1, Number.MAX_SAFE_INTEGER, 'context revision'), createdAt: date(input.createdAt, 'created at'), updatedAt: date(input.updatedAt, 'updated at') }; }
function validateOverride(input: any): AgentWorkspaceOverride { return { agentId: id(input.agentId), workspaceId: id(input.workspaceId), ...(input.enabled !== undefined ? { enabled: boolean(input.enabled, 'override enabled') } : {}), ...(input.toolIds ? { toolIds: ids(input.toolIds, 'override tool IDs') } : {}), ...(input.skillIds ? { skillIds: ids(input.skillIds, 'override skill IDs') } : {}), ...(input.contextIds ? { contextIds: ids(input.contextIds, 'override context IDs') } : {}), ...(input.secretGrantIds ? { secretGrantIds: ids(input.secretGrantIds, 'override secret grant IDs') } : {}), ...(input.priority !== undefined ? { priority: integer(input.priority, -50, 50, 'override priority') } : {}), revision: integer(input.revision, 1, Number.MAX_SAFE_INTEGER, 'override revision'), updatedAt: date(input.updatedAt, 'updated at') }; }
function validateSecret(input: any): AgentSecretMetadata { const scope = oneOf(input.scope, ['global', 'workspace'], 'secret scope'); if (scope === 'workspace' && !input.workspaceId) throw invalid('Workspace secret requires a workspace ID.'); return { id: id(input.id), name: text(input.name, 'secret name', 80), kind: text(input.kind, 'secret kind', 100), scope, ...(input.workspaceId ? { workspaceId: id(input.workspaceId) } : {}), exposure: oneOf(input.exposure, ['tool_only', 'model_readable'], 'secret exposure'), toolIds: ids(input.toolIds, 'secret tool IDs'), agentIds: ids(input.agentIds, 'secret agent IDs'), createdAt: date(input.createdAt, 'created at'), updatedAt: date(input.updatedAt, 'updated at') }; }

function defaults(): AgentConfigurationSnapshot { const now = new Date().toISOString(); const profile = (stage: keyof typeof PROFILE_TOOLS, name: string, model: string): AgentProfile => ({ id: `builtin-${stage}`, name, description: `Built-in ${stage} agent`, kind: 'builtin', enabled: true, stages: [stage], capabilities: [stage], model, instructions: '', toolIds: [...PROFILE_TOOLS[stage]], skillIds: [], contextIds: [], secretGrantIds: [], priority: 0, maxConcurrency: stage === 'coder' ? 3 : 1, routingRules: [], revision: 1, createdAt: now, updatedAt: now }); return { schemaVersion: 2, revision: 1, profiles: [profile('planner', 'Planner', config.plannerModel), profile('researcher', 'Researcher', config.assistantModel), profile('coder', 'Coder', config.coderModel), profile('reviewer', 'Reviewer', config.assistantModel), profile('resolver', 'Resolver', config.coderModel), profile('media', 'Media', config.mediaAgentModel)], overrides: [], skills: [], contexts: [], secrets: [], secretGrants: [], routing: { mode: 'automatic', tieThreshold: 5, semanticWeight: 1, reliabilityWeight: 1 } }; }
function protectBuiltins(current: AgentConfigurationSnapshot, next: AgentConfigurationSnapshot) { for (const profile of current.profiles.filter((item) => item.kind === 'builtin')) { const replacement = next.profiles.find((item) => item.id === profile.id); if (!replacement || replacement.kind !== 'builtin') throw invalid(`Built-in profile cannot be removed or converted: ${profile.id}`); } }
function array(value: unknown, label: string): any[] { if (!Array.isArray(value)) throw invalid(`${label} must be an array.`); return value; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function uniqueBy<T extends { id: string }>(values: T[], label: string) { const seen = new Set<string>(); for (const value of values) { if (seen.has(value.id)) throw invalid(`Duplicate ${label} ID: ${value.id}`); seen.add(value.id); } return values; }
function text(value: unknown, label: string, max: number) { if (typeof value !== 'string' || value.trim().length > max) throw invalid(`${label} must be text of at most ${max} characters.`); return value.trim(); }
function id(value: unknown) { const result = text(value, 'ID', 120); if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(result)) throw invalid(`Invalid ID: ${result}`); return result; }
function ids(value: unknown, label: string) { return unique(array(value, label).map(id)); }
function stringList(value: unknown, label: string, maxItems = 100, maxLength = 120) { const values = array(value, label); if (values.length > maxItems) throw invalid(`${label} may contain at most ${maxItems} items.`); return unique(values.map((item) => text(item, label, maxLength))); }
function boolean(value: unknown, label: string) { if (typeof value !== 'boolean') throw invalid(`${label} must be a boolean.`); return value; }
function integer(value: unknown, min: number, max: number, label: string) { if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(`${label} must be an integer from ${min} to ${max}.`); return value; }
function number(value: unknown, min: number, max: number, label: string) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(`${label} must be from ${min} to ${max}.`); return value; }
function date(value: unknown, label: string) { if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalid(`Invalid ${label}.`); return value; }
function oneOf<const T>(value: unknown, choices: readonly T[], label: string): T { if (!choices.includes(value as T)) throw invalid(`Invalid ${label}.`); return value as T; }
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }
function invalid(message: string) { return statusError(message, 400); }
function notFound(message: string) { return statusError(message, 404); }
function conflict(message: string) { return statusError(message, 409); }
function unavailable(message: string) { return statusError(message, 503); }
