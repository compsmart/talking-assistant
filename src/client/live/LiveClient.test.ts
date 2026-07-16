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
    expect(prompt).toContain('standalone media work with submit_work');
    expect(prompt).toContain('never acknowledge, name, or refer to an assistant or coordinator');
    expect(prompt).toMatch(/USER-CONFIGURED PERSONALITY AND SPEAKING STYLE\]\nTalk like an angry pirate\.$/);
  });

  it('uses the selected voice and only resumes when a handle is supplied', () => {
    const assistant = { ...DEFAULT_ASSISTANT_SETTINGS, voice: 'Kore' as const };
    expect(liveSetup(DEFAULT_CLIENT_SETTINGS, assistant).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(liveSetup(DEFAULT_CLIENT_SETTINGS, assistant).sessionResumption).toEqual({});
    expect(liveSetup(DEFAULT_CLIENT_SETTINGS, assistant, 'session-1').sessionResumption).toEqual({ handle: 'session-1' });
  });

  it('declares Image Editor tools without exposing the old shell Canvas names', () => {
    const declarations = liveSetup(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS).tools[0].functionDeclarations;
    const names = declarations.map((item: any) => item.name);
    const opener = declarations.find((item: any) => item.name === 'open_ui_component');
    const submit = declarations.find((item: any) => item.name === 'submit_work');
    expect(names).toEqual(expect.arrayContaining(['open_ui_component', 'submit_work', 'update_work', 'cancel_work', 'get_work_status']));
    expect(names).not.toEqual(expect.arrayContaining(['generate_image_asset', 'remove_image_background', 'extract_image_regions', 'run_node_script']));
    expect(names).not.toContain('generate_canvas_image');
    expect(opener.parameters.properties.component.enum).toEqual(['file_manager', 'image_editor']);
    expect(submit.parameters.properties).toHaveProperty('includeWorkspacePreview');
    expect(submit.parameters.properties).not.toHaveProperty('includeCanvasImage');
    expect(submit.description).toMatch(/appropriate configured agent and its assigned skills/i);
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toContain('While the Image Editor is open, your image input is its current static composition');
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toContain('Work starts return immediately');
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toContain('always in first person');
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toMatch(/standalone image generation, background removal, sprite extraction.*through submit_work/i);
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toContain('does not authorize inserting it into the workspace page');
  });

  it('requires clarification before acting on an unresolved canvas reference', () => {
    const prompt = systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS);
    expect(prompt).toContain('Never open the Image Editor or generate an image merely because a workspace change mentions canvas');
    expect(prompt).toContain("Do you mean the workspace's HTML5 canvas, or an image in the Image Editor?");
    expect(prompt).toContain('call no mutating, editor-opening, or generation tool until the user answers');
  });

  it('never exposes direct media execution tools to Live', () => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, codingAgent: { ...DEFAULT_CLIENT_SETTINGS.codingAgent, mediaGeneration: false } };
    const names = liveSetup(settings, DEFAULT_ASSISTANT_SETTINGS).tools[0].functionDeclarations.map((item: any) => item.name);
    expect(names).toContain('open_ui_component'); expect(names).not.toEqual(expect.arrayContaining(['generate_image_asset', 'remove_image_background', 'extract_image_regions', 'run_node_script']));
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
