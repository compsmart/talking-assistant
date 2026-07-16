import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSISTANT_SETTINGS } from '../settings/assistantDefaults';
import { DEFAULT_CLIENT_SETTINGS } from '../settings/defaults';
import { LiveClient, liveSetup, liveToolActivity, speechSafeText, systemPrompt } from './LiveClient';

describe('Gemini Live system prompt', () => {
  it('omits the personality section when no instructions are configured', () => {
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).not.toContain('USER-CONFIGURED PERSONALITY');
  });

  it('appends personality instructions after the core cowork instructions', () => {
    const assistant = { ...DEFAULT_ASSISTANT_SETTINGS, personalityPrompt: 'Talk like an angry pirate.' };
    const prompt = systemPrompt(DEFAULT_CLIENT_SETTINGS, assistant);
    expect(prompt).toContain('call delegate_to_assistant exactly once');
    expect(prompt).toContain('sole authority for task lifecycle');
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
    const handoff = declarations.find((item: any) => item.name === 'delegate_to_assistant');
    expect(names).toEqual(expect.arrayContaining(['open_ui_component', 'delegate_to_assistant', 'read_workspace_file']));
    expect(names).not.toEqual(expect.arrayContaining(['submit_work', 'update_work', 'cancel_work', 'get_work_status', 'edit_workspace_files', 'copy_reference_workspace_file']));
    expect(names).not.toEqual(expect.arrayContaining(['generate_image_asset', 'remove_image_background', 'extract_image_regions', 'run_node_script']));
    expect(names).not.toContain('generate_canvas_image');
    expect(opener.parameters.properties.component.enum).toEqual(['file_manager', 'image_editor']);
    expect(handoff.parameters.properties).toEqual({ note: expect.any(Object) });
    expect(handoff.description).toMatch(/authoritative Assistant/i);
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toContain('Speak the returned message faithfully');
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toContain('Planning must only be requested when the user explicitly asks');
    expect(systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS)).toContain('Never say, spell out, or read aloud a GUID');
  });

  it('requires clarification before acting on an unresolved canvas reference', () => {
    const prompt = systemPrompt(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS);
    expect(prompt).toContain('“Image Editor” refers only to the separate shell raster-composition window');
    expect(prompt).toContain("Do you mean the workspace's HTML5 canvas, or an image in the Image Editor?");
    expect(prompt).toContain('before delegating');
  });

  it('never exposes direct media execution tools to Live', () => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, codingAgent: { ...DEFAULT_CLIENT_SETTINGS.codingAgent, mediaGeneration: false } };
    const names = liveSetup(settings, DEFAULT_ASSISTANT_SETTINGS).tools[0].functionDeclarations.map((item: any) => item.name);
    expect(names).toContain('open_ui_component'); expect(names).not.toEqual(expect.arrayContaining(['generate_image_asset', 'remove_image_background', 'extract_image_regions', 'run_node_script']));
  });
});

describe('Live speech safety', () => {
  it('removes UUIDs and version hashes from application-authored speech', () => {
    expect(speechSafeText('Task 51bd169f-940e-446c-8e57-96e4e03c4bf1 failed.')).toBe('the task failed.');
    expect(speechSafeText('Version: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is ready.')).toBe('the current version is ready.');
  });
});

describe('Live tool execution', () => {
  it('maps blocking live operations to concise user-facing activities', () => {
    expect(liveToolActivity('delegate_to_assistant')).toEqual({ kind: 'delegating', label: 'Delegating' });
    expect(liveToolActivity('create_implementation_plan')).toEqual({ kind: 'planning', label: 'Planning' });
    expect(liveToolActivity('read_workspace_file')).toEqual({ kind: 'inspecting', label: 'Reading file' });
    expect(liveToolActivity('edit_workspace_files')).toEqual({ kind: 'editing', label: 'Editing workspace' });
  });

  it('reports only the period in which a tool call blocks the live response', async () => {
    const client = new LiveClient(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS); const states: Array<string | undefined> = []; let release!: () => void;
    client.onActivity = (activity) => states.push(activity?.label);
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = client.executeToolCalls([{ id: 'delegate', name: 'delegate_to_assistant', args: {} }], async () => { await gate; return { accepted: true }; });
    await Promise.resolve(); expect(states.at(-1)).toBe('Delegating'); release(); await running;
    expect(states.at(-1)).toBeUndefined();
  });

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
      { id: 'first', name: 'delegate_to_assistant', args: {} },
      { id: 'second', name: 'delegate_to_assistant', args: {} },
    ], async (call) => { order.push(`start-${call.id}`); if (call.id === 'first') await gate; order.push(`end-${call.id}`); return call.id; });
    await Promise.resolve(); await Promise.resolve(); expect(order).toEqual(['start-first']); release();
    await expect(running).resolves.toEqual(['first', 'second']); expect(order).toEqual(['start-first', 'end-first', 'start-second', 'end-second']);
  });

  it('rejects a replayed ID with different arguments', async () => {
    const client = new LiveClient(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS);
    await client.executeToolCalls([{ id: 'replay', name: 'edit_workspace_files', args: { edits: [] } }], async () => 'ok');
    await expect(client.executeToolCalls([{ id: 'replay', name: 'edit_workspace_files', args: { edits: [{ path: 'other' }] } }], async () => 'bad')).rejects.toThrow(/different arguments/);
  });

  it('keeps one stable authoritative user turn for a handoff', () => {
    const client = new LiveClient(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS);
    client.beginUserTurn('Change the title'); const first = client.currentUserTurn(); const second = client.currentUserTurn();
    expect(first?.text).toBe('Change the title'); expect(second?.id).toBe(first?.id);
  });
});
