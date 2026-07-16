import { describe, expect, it } from 'vitest';
import { ToolBroker } from './ToolBroker.js';
import { ToolCatalog } from './ToolCatalog.js';

const media = { type: 'function' as const, name: 'delegate_media_task', description: 'media', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['image', 'video', 'animation'] } } } };

describe('ToolBroker', () => {
  it('preserves an explicitly empty grant list', () => {
    expect(new ToolBroker(new ToolCatalog(), [media]).compile({ stage: 'coder', grantedToolIds: [] })).toEqual([]);
  });

  it('compiles virtual grants and denies ungranted fixed arguments', () => {
    const broker = new ToolBroker(new ToolCatalog(), [media]);
    const context = { stage: 'coder' as const, grantedToolIds: ['media.generate_image'] };
    expect(broker.compile(context)[0].parameters.properties.kind.enum).toEqual(['image']);
    expect(() => broker.authorize(context, 'delegate_media_task', { kind: 'video' })).toThrow('not enabled');
    expect(() => broker.authorize(context, 'delegate_media_task', { kind: 'image' })).not.toThrow();
  });
});
