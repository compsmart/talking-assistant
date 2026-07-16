import { describe, expect, it } from 'vitest';
import { assertToolPermission, classifyTask, CODING_AGENT_SYSTEM, CODING_TOOL_DEFINITIONS, CODING_TOOL_NAMES, executeCalls, toolsFor } from './CodingAgent.js';

describe('adaptive coding profile', () => {
  it('offers deterministic image processing alongside generation', () => {
    expect(CODING_TOOL_NAMES).toEqual(expect.arrayContaining(['delegate_media_task', 'remove_image_background', 'extract_image_regions', 'run_node_script']));
    expect(CODING_TOOL_NAMES).not.toEqual(expect.arrayContaining(['generate_image', 'generate_animation']));
  });
  it('routes generated animation through image-to-video frame controls instead of coded substitutes', () => {
    const animation = CODING_TOOL_DEFINITIONS.find((tool) => tool.name === 'delegate_media_task');
    expect(animation?.description).toMatch(/Media Agent/i);
    expect(animation?.description).toMatch(/placeholder paths/i);
    expect(animation?.parameters.properties).toHaveProperty('startFrame');
    expect(animation?.parameters.properties).toHaveProperty('endFrame');
    expect(animation?.parameters.properties.endFrame.description).toMatch(/same path/i);
    expect(animation?.parameters.properties).toHaveProperty('soundEffects');
  });
  it('does not present media delegation as a way to modify workspace canvases', () => {
    const media = CODING_TOOL_DEFINITIONS.find((tool) => tool.name === 'delegate_media_task');
    expect(media?.description).toMatch(/explicit request for a new image/i);
    expect(media?.description).toMatch(/never use it to modify a workspace HTML5 canvas/i);
  });
  it('does not treat standalone media creation as permission to edit or place it', () => {
    expect(CODING_AGENT_SYSTEM).toMatch(/standalone media request/i);
    expect(CODING_AGENT_SYSTEM).toMatch(/do not edit application files/i);
    expect(CODING_AGENT_SYSTEM).toMatch(/only when the user explicitly asked to place or use the asset/i);
  });
  it('requires stable selection identifiers on every new semantic DOM element', () => {
    expect(CODING_AGENT_SYSTEM).toMatch(/Every newly created user-visible semantic DOM element must have.*data-cowork-id/i);
    expect(CODING_AGENT_SYSTEM).toMatch(/Never generate duplicate data-cowork-id values/i);
  });
  it('narrows and enforces delegated media kinds from scoped registry grants', () => {
    const settings = { codingAgent: { mediaGeneration: true, dependencies: 'allow', validation: 'standard' } } as any;
    const agent = { id: 'animation', name: 'Animator', revision: 1, enabledToolIds: ['media.generate_animation'] };
    const media = toolsFor(settings, false, agent).find((item) => item.name === 'delegate_media_task');
    expect(media?.parameters.properties.kind.enum).toEqual(['animation']);
    expect(() => assertToolPermission(agent, 'delegate_media_task', { kind: 'animation' })).not.toThrow();
    expect(() => assertToolPermission(agent, 'delegate_media_task', { kind: 'video' })).toThrow(/not enabled/);
    expect(toolsFor(settings, false, { ...agent, enabledToolIds: [] })).toHaveLength(0);
  });
  it('uses low thinking for localized changes and medium for broad work and repairs', () => {
    expect(classifyTask('Change the selected heading color to blue', [], 'adaptive')).toMatchObject({ surgical: true, thinkingLevel: 'low', summaries: false });
    expect(classifyTask('Debug the authentication feature across the application', [], 'adaptive')).toMatchObject({ surgical: false, thinkingLevel: 'medium' });
    expect(classifyTask('Change one color', [], 'fast', true)).toMatchObject({ thinkingLevel: 'medium', summaries: true });
  });

  it('runs adjacent reads concurrently while preserving result and mutation order', async () => {
    const order: string[] = [];
    const calls = [{ call: { name: 'read_files' }, id: 'slow' }, { call: { name: 'locate_code' }, id: 'fast' }, { call: { name: 'apply_edits' }, id: 'write' }, { call: { name: 'apply_edits' }, id: 'write2' }];
    const results = await executeCalls(calls, async (item) => {
      if (item.id === 'slow') await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(item.id); return item.id;
    });
    expect(results).toEqual(['slow', 'fast', 'write', 'write2']);
    expect(order.slice(-2)).toEqual(['write', 'write2']);
  });
});
