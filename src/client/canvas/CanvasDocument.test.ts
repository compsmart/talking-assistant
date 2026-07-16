import { describe, expect, it } from 'vitest';
import { CANVAS_HEIGHT, CANVAS_WIDTH, emptyCanvasDocument, moveLayer, normalizeCanvasDocument, type CanvasImageLayer } from './CanvasDocument';

const layer = (id: string): CanvasImageLayer => ({ id, name: id, path: `uploads/images/${id}.webp`, left: 1, top: 2, scaleX: 1, scaleY: 1, angle: 0, opacity: 1, visible: true });

describe('Canvas documents', () => {
  it('creates a stable empty document for each workspace', () => {
    expect(emptyCanvasDocument('workspace-1')).toMatchObject({ workspaceId: 'workspace-1', width: CANVAS_WIDTH, height: CANVAS_HEIGHT, layers: [] });
  });

  it('normalizes persisted data and ignores malformed layers', () => {
    const edited = { ...layer('a'), editedData: 'data:image/png;base64,edited' };
    const normalized = normalizeCanvasDocument({ width: 10, height: 20, layers: [edited, { id: 'broken' }] }, 'workspace-2');
    expect(normalized.workspaceId).toBe('workspace-2');
    expect(normalized.width).toBe(CANVAS_WIDTH); expect(normalized.height).toBe(CANVAS_HEIGHT);
    expect(normalized.layers.map((item) => item.id)).toEqual(['a']);
    expect(normalized.layers[0].editedData).toBe(edited.editedData);
  });

  it('reorders layers without mutating the source list or crossing its bounds', () => {
    const source = [layer('a'), layer('b'), layer('c')];
    expect(moveLayer(source, 'b', 1).map((item) => item.id)).toEqual(['a', 'c', 'b']);
    expect(moveLayer(source, 'a', -1).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(source.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});
