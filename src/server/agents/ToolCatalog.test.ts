import { describe, expect, it } from 'vitest';
import { ToolCatalog } from './ToolCatalog.js';

describe('agent tool catalog', () => {
  it('enforces stage and workspace ceilings when resolving effective tools', () => {
    const catalog = new ToolCatalog();
    expect(catalog.effective({ stage: 'planner', profileToolIds: ['read_files', 'apply_edits'] }).map((item) => item.id)).toEqual(['read_files']);
    expect(catalog.effective({ stage: 'coder', profileToolIds: ['read_files', 'apply_edits'], workspaceToolIds: ['read_files'] }).map((item) => item.id)).toEqual(['read_files']);
  });

  it('returns defensive copies and rejects duplicate registrations', () => {
    const catalog = new ToolCatalog(); const tools = catalog.list(); tools[0].available = false;
    expect(catalog.get(tools[0].id)?.available).toBe(true);
    expect(() => catalog.register(catalog.get('read_files')!)).toThrow('already registered');
  });

  it('publishes independently configurable media capabilities backed by the persistent media executor', () => {
    const catalog = new ToolCatalog();
    const animation = catalog.get('media.generate_animation');
    const video = catalog.get('media.generate_video');
    expect(animation).toMatchObject({ runtimeToolId: 'delegate_media_task', fixedArguments: { kind: 'animation' } });
    expect(animation?.inputSchema?.required).toEqual(expect.arrayContaining(['startFrame']));
    expect(video).toMatchObject({ runtimeToolId: 'delegate_media_task', fixedArguments: { kind: 'video' } });
    expect(catalog.get('delegate_media_task')).toBeUndefined();
    expect(catalog.get('media.generate_image')?.description).toMatch(/never use this for a workspace HTML5 canvas change/i);
  });

  it('publishes ordered categories and object schemas for every unique tool', () => {
    const catalog = new ToolCatalog(); const directory = catalog.directory();
    expect(directory.categories.map((category) => category.order)).toEqual([...directory.categories.map((category) => category.order)].sort((a, b) => a - b));
    expect(new Set(directory.tools.map((tool) => tool.id)).size).toBe(directory.tools.length);
    expect(directory.tools.every((tool) => tool.inputSchema?.type === 'object' && tool.outputSchema?.type === 'object')).toBe(true);
    expect(directory.tools.every((tool) => directory.categories.some((category) => category.id === tool.categoryId))).toBe(true);
  });

  it('offers the constrained Node-script runner to every agent stage', () => {
    const tool = new ToolCatalog().get('run_node_script');
    expect(tool?.stages).toEqual(expect.arrayContaining(['planner', 'researcher', 'coder', 'reviewer', 'resolver', 'media']));
    expect(tool?.inputSchema?.required).toEqual(['script']);
    expect(tool?.risks).not.toContain('network');
  });

  it('reserves deterministic image processing for the Media stage', () => {
    const catalog = new ToolCatalog();
    expect(catalog.get('extract_image_regions')?.stages).toEqual(['media']);
    expect(catalog.get('remove_image_background')?.stages).toEqual(['media']);
    expect(catalog.effective({ stage: 'coder', profileToolIds: ['extract_image_regions', 'remove_image_background'] })).toEqual([]);
  });
});
