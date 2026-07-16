import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSISTANT_SETTINGS } from '../settings/assistantDefaults';
import { DEFAULT_CLIENT_SETTINGS } from '../settings/defaults';
import { LiveClient, liveSetup, systemPrompt } from './LiveClient';

describe('Gemini Live system prompt', () => {
  it('omits the personality section when no instructions are configured', () => {
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).not.toContain('USER-CONFIGURED PERSONALITY');
  });

  it('appends personality instructions after the core cowork instructions', () => {
    const assistant = { ...DEFAULT_ASSISTANT_SETTINGS, personalityPrompt: 'Talk like an angry pirate.' };
    const prompt = systemPrompt(DEFAULT_CLIENT_SETTINGS, assistant);
    expect(prompt).toContain('Use create_implementation_plan for architectural work');
    expect(prompt).toMatch(/USER-CONFIGURED PERSONALITY AND SPEAKING STYLE\]\nTalk like an angry pirate\.$/);
  });

  it('uses the selected voice and only resumes when a handle is supplied', () => {
    const assistant = { ...DEFAULT_ASSISTANT_SETTINGS, voice: 'Kore' as const };
    expect(liveSetup(DEFAULT_CLIENT_SETTINGS, assistant).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(liveSetup(DEFAULT_CLIENT_SETTINGS, assistant).sessionResumption).toEqual({});
    expect(liveSetup(DEFAULT_CLIENT_SETTINGS, assistant, 'session-1').sessionResumption).toEqual({ handle: 'session-1' });
  });

  it('declares shell component and Canvas image tools when media generation is enabled', () => {
    const declarations = liveSetup(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS).tools[0].functionDeclarations;
    expect(declarations.map((item: any) => item.name)).toEqual(expect.arrayContaining(['open_ui_component', 'generate_canvas_image', 'create_implementation_plan', 'execute_implementation_plan', 'respond_to_planning_continuation', 'get_agent_run_status']));
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toContain('While Canvas is open, your image input is the current static Canvas composition');
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toContain('Agent starts return immediately');
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toContain('never apply that continuation to a different request');
  });

  it('keeps the UI opener but hides Canvas generation when media generation is disabled', () => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, codingAgent: { ...DEFAULT_CLIENT_SETTINGS.codingAgent, mediaGeneration: false } };
    const names = liveSetup(settings, DEFAULT_ASSISTANT_SETTINGS).tools[0].functionDeclarations.map((item: any) => item.name);
    expect(names).toContain('open_ui_component'); expect(names).not.toContain('generate_canvas_image');
  });
});

describe('Live tool execution', () => {
  it('deduplicates calls by ID and reuses the completed result', async () => {
    const client = new LiveClient(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS); let calls = 0;
    const call = { id: 'same-call', name: 'edit_workspace_files', args: { edits: [{ path: 'a.txt', mode: 'write' }] } };
    const execute = async () => ({ ok: ++calls });
    const [first] = await client.executeToolCalls([call], execute); const [second] = await client.executeToolCalls([call], execute);
    expect(first).toEqual({ ok: 1 }); expect(second).toEqual({ ok: 1 }); expect(calls).toBe(1);
  });

  it('serializes workspace mutations while allowing each result to complete', async () => {
    const client = new LiveClient(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS); const order: string[] = []; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = client.executeToolCalls([
      { id: 'first', name: 'edit_workspace_files', args: { edits: [] } },
      { id: 'second', name: 'edit_workspace_files', args: { edits: [] } },
    ], async (call) => { order.push(`start-${call.id}`); if (call.id === 'first') await gate; order.push(`end-${call.id}`); return call.id; });
    await Promise.resolve(); await Promise.resolve(); expect(order).toEqual(['start-first']); release();
    await expect(running).resolves.toEqual(['first', 'second']); expect(order).toEqual(['start-first', 'end-first', 'start-second', 'end-second']);
  });

  it('rejects a replayed ID with different arguments', async () => {
    const client = new LiveClient(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS);
    await client.executeToolCalls([{ id: 'replay', name: 'edit_workspace_files', args: { edits: [] } }], async () => 'ok');
    await expect(client.executeToolCalls([{ id: 'replay', name: 'edit_workspace_files', args: { edits: [{ path: 'other' }] } }], async () => 'bad')).rejects.toThrow(/different arguments/);
  });
});
