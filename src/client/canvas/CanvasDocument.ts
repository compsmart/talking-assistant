export const CANVAS_WIDTH = 1024;
export const CANVAS_HEIGHT = 768;
export const CANVAS_DOCUMENT_VERSION = 1;

export type CanvasTool = 'select' | 'pan' | 'brush' | 'eraser' | 'picker' | 'magic';

export interface CanvasImageLayer {
  id: string;
  name: string;
  path: string;
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  opacity: number;
  visible: boolean;
  editedData?: string;
}

export interface CanvasDocumentRecord {
  version: 1;
  workspaceId: string;
  width: number;
  height: number;
  layers: CanvasImageLayer[];
  paint?: Blob;
  updatedAt: string;
}

export function emptyCanvasDocument(workspaceId: string): CanvasDocumentRecord {
  return { version: CANVAS_DOCUMENT_VERSION, workspaceId, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, layers: [], updatedAt: new Date().toISOString() };
}

export function normalizeCanvasDocument(value: unknown, workspaceId: string): CanvasDocumentRecord {
  const source = value && typeof value === 'object' ? value as Partial<CanvasDocumentRecord> : {};
  const layers = Array.isArray(source.layers) ? source.layers.filter(validLayer).map((layer) => ({ ...layer })) : [];
  return {
    version: CANVAS_DOCUMENT_VERSION,
    workspaceId,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    layers,
    paint: source.paint instanceof Blob ? source.paint : undefined,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
  };
}

export function moveLayer(layers: CanvasImageLayer[], id: string, direction: -1 | 1) {
  const next = layers.map((layer) => ({ ...layer }));
  const index = next.findIndex((layer) => layer.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function validLayer(value: unknown): value is CanvasImageLayer {
  if (!value || typeof value !== 'object') return false;
  const layer = value as Partial<CanvasImageLayer>;
  return typeof layer.id === 'string' && typeof layer.name === 'string' && typeof layer.path === 'string'
    && ['left', 'top', 'scaleX', 'scaleY', 'angle', 'opacity'].every((key) => Number.isFinite(layer[key as keyof CanvasImageLayer]))
    && typeof layer.visible === 'boolean'
    && (layer.editedData === undefined || typeof layer.editedData === 'string');
}
