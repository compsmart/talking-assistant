import { describe, expect, it } from 'vitest';
import { classifyTask, CODING_TOOL_DEFINITIONS, CODING_TOOL_NAMES, executeCalls } from './CodingAgent.js';

describe('adaptive coding profile', () => {
  it('offers deterministic image processing alongside generation', () => {
    expect(CODING_TOOL_NAMES).toEqual(expect.arrayContaining(['delegate_media_task', 'remove_image_background', 'extract_image_regions']));
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
