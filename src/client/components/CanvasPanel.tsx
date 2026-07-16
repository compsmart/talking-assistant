import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Canvas as FabricCanvas, FabricImage, FabricObject, Point, util } from 'fabric';
import type { AssetRecord } from '../../shared/protocol';
import { rawFileUrl, uploadFiles } from '../files/FileClient';
import { CANVAS_HEIGHT, CANVAS_WIDTH, emptyCanvasDocument, normalizeCanvasDocument, type CanvasDocumentRecord, type CanvasImageLayer, type CanvasTool } from '../canvas/CanvasDocument';
import { loadCanvasDocument, saveCanvasDocument } from '../canvas/CanvasStore';
import { FloatingWindow } from './FloatingWindow';

const WORKSPACE_FILE_MIME = 'application/x-cowork-workspace-file';
const HISTORY_LIMIT = 50;
const HISTORY_BYTES = 64 * 1024 * 1024;

export interface CanvasPlacement { x?: number; y?: number; width?: number }
export interface CanvasContextValue { width: number; height: number; layers: CanvasImageLayer[]; selectedLayerId?: string; tool: CanvasTool }

export interface CanvasPanelHandle {
  addWorkspaceImages: (paths: string[], placement?: CanvasPlacement) => Promise<string[]>;
  setTool: (tool: CanvasTool) => void;
  getContext: () => CanvasContextValue;
  getCompositeCanvas: () => HTMLCanvasElement | null;
  flush: () => Promise<void>;
}

interface Props {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
  onError: (message: string) => void;
  onSaved: (path: string, version: string) => void;
  onCompositeChange?: (canvas: HTMLCanvasElement | null) => void;
  busyMessage?: string;
  visionActive?: boolean;
}

interface HistorySnapshot { layers: CanvasImageLayer[]; paint: string; bytes: number }
interface MagicSelection { layerId: string; target: [number, number, number] }

export const CanvasPanel = forwardRef<CanvasPanelHandle, Props>(function CanvasPanel({ open, workspaceId, onClose, onError, onSaved, onCompositeChange, busyMessage, visionActive }, ref) {
  const element = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const paint = useRef<HTMLCanvasElement>(null);
  const magicOverlay = useRef<HTMLCanvasElement>(null);
  const composite = useRef<HTMLCanvasElement>(null);
  const compositing = useRef(false);
  const fabric = useRef<FabricCanvas | undefined>(undefined);
  const restoring = useRef(false);
  const activeWorkspace = useRef(workspaceId);
  const saveTimer = useRef(0);
  const history = useRef<HistorySnapshot[]>([]);
  const historyIndex = useRef(-1);
  const drawing = useRef<{ pointerId: number; x: number; y: number } | undefined>(undefined);
  const panning = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number } | undefined>(undefined);
  const internalClipboard = useRef<CanvasImageLayer | undefined>(undefined);
  const panelActive = useRef(false);
  const magicSelection = useRef<MagicSelection | undefined>(undefined);
  const [layers, setLayers] = useState<CanvasImageLayer[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [tool, setTool] = useState<CanvasTool>('select');
  const [color, setColor] = useState('#1f2937');
  const [brushSize, setBrushSize] = useState(16);
  const [opacity, setOpacity] = useState(1);
  const [magicTolerance, setMagicTolerance] = useState(24);
  const [magicPixels, setMagicPixels] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fitSize, setFitSize] = useState({ width: 720, height: 540 });
  const [clearOpen, setClearOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const serializeLayers = useCallback(() => {
    const canvas = fabric.current;
    if (!canvas) return [];
    return canvas.getObjects().map((object) => layerFromObject(object)).filter(Boolean) as CanvasImageLayer[];
  }, []);

  const renderComposite = useCallback(() => {
    const canvas = fabric.current; const output = composite.current; const paintCanvas = paint.current;
    if (!canvas || !output || !paintCanvas || compositing.current) return;
    compositing.current = true;
    try {
      const context = output.getContext('2d')!; const skipControls = (canvas as any).skipControlsDrawing; (canvas as any).skipControlsDrawing = true;
      try { canvas.renderCanvas(context, canvas.getObjects()); }
      finally { (canvas as any).skipControlsDrawing = skipControls; }
      context.drawImage(paintCanvas, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT); onCompositeChange?.(output);
    } finally { compositing.current = false; }
  }, [onCompositeChange]);

  const clearMagicSelection = useCallback(() => {
    magicSelection.current = undefined; setMagicPixels(0);
    const overlay = magicOverlay.current; if (overlay) overlay.getContext('2d')!.clearRect(0, 0, overlay.width, overlay.height);
  }, []);

  const renderMagicSelection = useCallback((tolerance = magicTolerance) => {
    const selection = magicSelection.current; const canvas = fabric.current; const overlay = magicOverlay.current;
    if (!selection || !canvas || !overlay) return;
    const object = canvas.getObjects().find((item) => layerId(item) === selection.layerId);
    if (!(object instanceof FabricImage)) { clearMagicSelection(); return; }
    const source = sourceCanvasForImage(object); const match = matchingMask(source, selection.target, tolerance);
    const context = overlay.getContext('2d')!; context.clearRect(0, 0, overlay.width, overlay.height); context.save();
    const [a, b, c, d, e, f] = object.calcTransformMatrix(); context.setTransform(a, b, c, d, e, f); context.drawImage(match.canvas, -object.width / 2, -object.height / 2, object.width, object.height); context.restore();
    setMagicPixels(match.count);
  }, [clearMagicSelection, magicTolerance]);

  const currentSnapshot = useCallback((): HistorySnapshot => {
    const paintData = paint.current?.toDataURL('image/png') || '';
    const nextLayers = serializeLayers();
    return { layers: nextLayers, paint: paintData, bytes: paintData.length + JSON.stringify(nextLayers).length };
  }, [serializeLayers]);

  const persist = useCallback(async (id = activeWorkspace.current) => {
    const paintBlob = paint.current ? await canvasBlob(paint.current, 'image/png') : undefined;
    const document: CanvasDocumentRecord = { ...emptyCanvasDocument(id), layers: serializeLayers(), paint: paintBlob || undefined, updatedAt: new Date().toISOString() };
    await saveCanvasDocument(document);
  }, [serializeLayers]);

  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persist().catch((error) => onError((error as Error).message)), 500);
  }, [onError, persist]);

  const pushHistory = useCallback(() => {
    if (restoring.current) return;
    const snapshot = currentSnapshot();
    const next = history.current.slice(0, historyIndex.current + 1); next.push(snapshot);
    let bytes = next.reduce((total, item) => total + item.bytes, 0);
    while (next.length > HISTORY_LIMIT || (next.length > 1 && bytes > HISTORY_BYTES)) bytes -= next.shift()!.bytes;
    history.current = next; historyIndex.current = next.length - 1;
    const nextLayers = snapshot.layers; setLayers(nextLayers); renderComposite(); scheduleSave();
  }, [currentSnapshot, renderComposite, scheduleSave]);

  const applySnapshot = useCallback(async (snapshot: HistorySnapshot) => {
    restoring.current = true;
    try {
      await replaceLayers(fabric.current!, snapshot.layers, onError);
      await loadPaint(paint.current!, snapshot.paint);
      setLayers(snapshot.layers.map((layer) => ({ ...layer }))); setSelectedId(undefined); clearMagicSelection();
      fabric.current!.discardActiveObject(); fabric.current!.requestRenderAll(); renderComposite(); scheduleSave();
    } finally { restoring.current = false; }
  }, [clearMagicSelection, onError, renderComposite, scheduleSave]);

  const undo = useCallback(async () => {
    if (historyIndex.current <= 0) return;
    historyIndex.current--; await applySnapshot(history.current[historyIndex.current]);
  }, [applySnapshot]);
  const redo = useCallback(async () => {
    if (historyIndex.current >= history.current.length - 1) return;
    historyIndex.current++; await applySnapshot(history.current[historyIndex.current]);
  }, [applySnapshot]);

  const addWorkspaceImages = useCallback(async (paths: string[], placement?: CanvasPlacement) => {
    const canvas = fabric.current; if (!canvas) throw new Error('The Image Editor is still opening.');
    const ids: string[] = [];
    for (const path of paths) {
      if (!isImagePath(path)) { onError(`${path} is not a supported Image Editor asset.`); continue; }
      const id = crypto.randomUUID(); const image = await objectForPath(path, id, placement).catch((error) => { onError(`Could not add ${path}: ${(error as Error).message}`); return undefined; });
      if (!image) continue;
      canvas.add(image); canvas.setActiveObject(image); ids.push(id); setSelectedId(id);
    }
    if (ids.length) { canvas.requestRenderAll(); pushHistory(); }
    return ids;
  }, [onError, pushHistory]);

  useEffect(() => {
    if (!element.current || fabric.current) return;
    const canvas = new FabricCanvas(element.current, { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, preserveObjectStacking: true, selectionColor: 'rgba(124,243,206,.14)', selectionBorderColor: '#7cf3ce' });
    fabric.current = canvas;
    const selection = (event: any) => { const id = layerId(event.selected?.[0] || event.target); setSelectedId(id); if (magicSelection.current?.layerId !== id) clearMagicSelection(); };
    canvas.on('selection:created', selection); canvas.on('selection:updated', selection); canvas.on('selection:cleared', () => { setSelectedId(undefined); clearMagicSelection(); });
    canvas.on('object:modified', () => { clearMagicSelection(); pushHistory(); }); canvas.on('after:render', renderComposite);
    return () => { canvas.dispose(); fabric.current = undefined; };
  }, [clearMagicSelection, pushHistory, renderComposite]);

  useEffect(() => {
    const target = viewport.current; if (!target) return;
    const update = () => {
      const width = Math.max(200, target.clientWidth - 40); const height = Math.max(150, target.clientHeight - 40); const scale = Math.min(width / CANVAS_WIDTH, height / CANVAS_HEIGHT);
      setFitSize({ width: Math.round(CANVAS_WIDTH * scale), height: Math.round(CANVAS_HEIGHT * scale) });
    };
    const observer = new ResizeObserver(update); observer.observe(target); update(); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!fabric.current || !paint.current || !workspaceId) return;
    let cancelled = false;
    const restore = async () => {
      if (activeWorkspace.current !== workspaceId) await persist(activeWorkspace.current).catch((error) => onError((error as Error).message));
      activeWorkspace.current = workspaceId; restoring.current = true;
      try {
        const document = normalizeCanvasDocument(await loadCanvasDocument(workspaceId), workspaceId);
        if (cancelled) return;
        await replaceLayers(fabric.current!, document.layers, onError);
        await loadPaintBlob(paint.current!, document.paint);
        setLayers(document.layers.map((layer) => ({ ...layer }))); setSelectedId(undefined); clearMagicSelection();
        fabric.current!.requestRenderAll(); renderComposite();
        const first = currentSnapshot(); history.current = [first]; historyIndex.current = 0;
      } catch (error) { onError((error as Error).message); }
      finally { restoring.current = false; }
    };
    void restore(); return () => { cancelled = true; };
  }, [clearMagicSelection, currentSnapshot, onError, persist, renderComposite, workspaceId]);

  useEffect(() => {
    const pointer = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest('.canvas-window')) panelActive.current = false; };
    window.addEventListener('pointerdown', pointer, true); return () => window.removeEventListener('pointerdown', pointer, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (!panelActive.current || isTypingTarget(event.target)) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); void (event.shiftKey ? redo() : undo()); }
      else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); void redo(); }
      else if (modifier && event.key.toLowerCase() === 'c') { event.preventDefault(); void copySelected(); }
      else if (modifier && event.key.toLowerCase() === 'v') { event.preventDefault(); void pasteInternal(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (magicSelection.current) deleteMagicPixels(); else removeSelected(); }
    };
    const paste = (event: ClipboardEvent) => {
      if (!panelActive.current || isTypingTarget(event.target)) return;
      const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'));
      if (files.length) { event.preventDefault(); void importFiles(files); }
    };
    window.addEventListener('keydown', keydown); window.addEventListener('paste', paste);
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('paste', paste); };
  });

  useEffect(() => () => { window.clearTimeout(saveTimer.current); void persist().catch(() => undefined); onCompositeChange?.(null); }, [onCompositeChange, persist]);

  const removeSelected = () => {
    const object = fabric.current?.getActiveObject(); if (!object) return;
    clearMagicSelection(); fabric.current!.remove(object); fabric.current!.discardActiveObject(); setSelectedId(undefined); pushHistory();
  };
  const duplicateSelected = async () => {
    const source = layers.find((layer) => layer.id === selectedId); if (!source) return;
    const id = crypto.randomUUID(); const duplicate = { ...source, id, name: `${source.name} copy`, left: source.left + 18, top: source.top + 18 };
    const image = await objectFromLayer(duplicate); fabric.current!.add(image); fabric.current!.setActiveObject(image); setSelectedId(id); fabric.current!.requestRenderAll(); pushHistory();
  };
  const copySelected = async () => {
    const source = layers.find((layer) => layer.id === selectedId); const object = fabric.current?.getActiveObject(); if (!source || !object) return;
    internalClipboard.current = { ...source };
    try {
      const blob = await canvasBlob(object.toCanvasElement(), 'image/png');
      if (blob && 'ClipboardItem' in window) await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch { /* internal clipboard remains available */ }
  };
  const pasteInternal = async () => {
    const source = internalClipboard.current; if (!source) return;
    const id = crypto.randomUUID(); const duplicate = { ...source, id, name: `${source.name} copy`, left: source.left + 18, top: source.top + 18 };
    const image = await objectFromLayer(duplicate); fabric.current!.add(image); fabric.current!.setActiveObject(image); setSelectedId(id); fabric.current!.requestRenderAll(); pushHistory();
  };

  const reorder = (id: string, direction: -1 | 1) => {
    const canvas = fabric.current!; const object = canvas.getObjects().find((item) => layerId(item) === id); if (!object) return;
    const index = canvas.getObjects().indexOf(object); canvas.moveObjectTo(object, Math.max(0, Math.min(canvas.size() - 1, index + direction))); canvas.requestRenderAll(); pushHistory();
  };
  const toggleVisible = (id: string) => {
    const object = fabric.current!.getObjects().find((item) => layerId(item) === id); if (!object) return;
    object.set('visible', !object.visible); fabric.current!.requestRenderAll(); pushHistory();
  };

  const selectMagicColor = (x: number, y: number) => {
    const object = fabric.current?.getActiveObject();
    if (!(object instanceof FabricImage)) { onError('Select an image layer before using Magic Select.'); return; }
    const source = sourceCanvasForImage(object); const local = util.transformPoint(new Point(x, y), util.invertTransform(object.calcTransformMatrix()));
    const pixelX = Math.floor((local.x + object.width / 2) * source.width / object.width); const pixelY = Math.floor((local.y + object.height / 2) * source.height / object.height);
    if (pixelX < 0 || pixelY < 0 || pixelX >= source.width || pixelY >= source.height) { onError('Click inside the selected image.'); return; }
    const pixel = source.getContext('2d')!.getImageData(pixelX, pixelY, 1, 1).data;
    if (!pixel[3]) { onError('That pixel is already transparent.'); return; }
    magicSelection.current = { layerId: layerId(object)!, target: [pixel[0], pixel[1], pixel[2]] }; renderMagicSelection();
  };

  const deleteMagicPixels = () => {
    const selection = magicSelection.current; if (!selection) return;
    const object = fabric.current?.getObjects().find((item) => layerId(item) === selection.layerId);
    if (!(object instanceof FabricImage)) { clearMagicSelection(); return; }
    const source = sourceCanvasForImage(object); const context = source.getContext('2d')!; const pixels = context.getImageData(0, 0, source.width, source.height); let removed = 0;
    for (let offset = 0; offset < pixels.data.length; offset += 4) if (matchesColor(pixels.data, offset, selection.target, magicTolerance)) { pixels.data[offset + 3] = 0; removed++; }
    if (!removed) { clearMagicSelection(); return; }
    context.putImageData(pixels, 0, 0); object.setElement(source, { width: source.width, height: source.height }); (object as any).editedData = source.toDataURL('image/png'); object.dirty = true;
    clearMagicSelection(); fabric.current!.requestRenderAll(); pushHistory();
  };

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(); return { x: (event.clientX - rect.left) * CANVAS_WIDTH / rect.width, y: (event.clientY - rect.top) * CANVAS_HEIGHT / rect.height };
  };
  const changeZoom = (nextValue: number, client?: { x: number; y: number }) => {
    const next = clamp(nextValue, .25, 4); if (next === zoom) return;
    if (client && viewport.current) {
      const rect = viewport.current.getBoundingClientRect(); const relative = { x: client.x - (rect.left + rect.width / 2), y: client.y - (rect.top + rect.height / 2) }; const ratio = next / zoom;
      setPan((current) => ({ x: relative.x - (relative.x - current.x) * ratio, y: relative.y - (relative.y - current.y) * ratio }));
    }
    setZoom(next);
  };
  useEffect(() => {
    const target = viewport.current; if (!target) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); changeZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), { x: event.clientX, y: event.clientY }); };
    target.addEventListener('wheel', wheel, { passive: false }); return () => target.removeEventListener('wheel', wheel);
  }, [zoom]);
  const beginPaint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const where = point(event);
    if (tool === 'pan') { event.currentTarget.setPointerCapture(event.pointerId); panning.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, ...pan }; return; }
    if (tool === 'magic') { selectMagicColor(where.x, where.y); return; }
    if (tool === 'picker') {
      renderComposite(); const pixel = composite.current!.getContext('2d')!.getImageData(Math.floor(where.x), Math.floor(where.y), 1, 1).data;
      setColor(`#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`); setTool('brush'); return;
    }
    if (!['brush', 'eraser'].includes(tool)) return;
    event.currentTarget.setPointerCapture(event.pointerId); drawing.current = { pointerId: event.pointerId, ...where };
    drawStroke(where.x, where.y, where.x + .01, where.y + .01);
  };
  const movePaint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panning.current?.pointerId === event.pointerId) { setPan({ x: panning.current.x + event.clientX - panning.current.clientX, y: panning.current.y + event.clientY - panning.current.clientY }); return; }
    if (!drawing.current || drawing.current.pointerId !== event.pointerId) return;
    const where = point(event); drawStroke(drawing.current.x, drawing.current.y, where.x, where.y); drawing.current = { pointerId: event.pointerId, ...where };
  };
  const endPaint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panning.current?.pointerId === event.pointerId) { panning.current = undefined; return; }
    if (!drawing.current || drawing.current.pointerId !== event.pointerId) return;
    drawing.current = undefined; pushHistory();
  };
  const drawStroke = (x1: number, y1: number, x2: number, y2: number) => {
    const context = paint.current!.getContext('2d')!; context.save(); context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'; context.globalAlpha = opacity;
    context.strokeStyle = color; context.lineWidth = brushSize; context.lineCap = 'round'; context.lineJoin = 'round'; context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke(); context.restore(); renderComposite();
  };

  const importFiles = async (files: File[]) => {
    setUploading(true);
    try { const result = await uploadFiles(files, { accept: 'image' }); onSaved('', result.version); await addWorkspaceImages(result.value.map((item) => item.path)); }
    catch (error) { onError((error as Error).message); }
    finally { setUploading(false); }
  };
  const drop = async (event: React.DragEvent) => {
    event.preventDefault(); event.stopPropagation();
    const path = event.dataTransfer.getData(WORKSPACE_FILE_MIME);
    if (path) { await addWorkspaceImages([path]); return; }
    const files = Array.from(event.dataTransfer.files); if (files.length) await importFiles(files);
  };
  const saveImage = async () => {
    renderComposite(); setSaving(true);
    try {
      const blob = await canvasBlob(composite.current!, 'image/webp', .92); if (!blob) throw new Error('Could not encode the Image Editor composition as WebP.');
      const filename = `image-editor-${new Date().toISOString().replace(/[:.]/g, '-')}.webp`;
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      const result = await uploadFiles([new File([blob], filename, { type: 'image/webp' })], { accept: 'image' }); const record = result.value[0]; onSaved(record.path, result.version);
    } catch (error) { onError((error as Error).message); }
    finally { setSaving(false); }
  };
  const clear = () => {
    clearMagicSelection(); fabric.current!.clear(); paint.current!.getContext('2d')!.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT); setSelectedId(undefined); setClearOpen(false); fabric.current!.requestRenderAll(); pushHistory();
  };

  useImperativeHandle(ref, () => ({
    addWorkspaceImages,
    setTool,
    getContext: () => ({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, layers: serializeLayers(), selectedLayerId: selectedId, tool }),
    getCompositeCanvas: () => composite.current,
    flush: () => persist(),
  }), [addWorkspaceImages, persist, selectedId, serializeLayers, tool]);

  return <div className={`canvas-panel-host ${open ? 'open' : ''}`} onPointerDown={() => { panelActive.current = true; }}>
    <FloatingWindow id="canvas" title="Image Editor" initial={{ x: 120, y: 54, width: 940, height: 680 }} minWidth={650} minHeight={470} className="canvas-window" onClose={onClose}
      headerActions={<span className={`canvas-live-indicator ${visionActive ? 'active' : ''}`}><i /> Live vision</span>}>
      <div className="canvas-editor">
        <div className="canvas-tools" role="toolbar" aria-label="Image Editor tools">
          {(['select', 'pan', 'brush', 'eraser', 'picker', 'magic'] as CanvasTool[]).map((item) => <button key={item} className={tool === item ? 'active' : ''} onClick={() => setTool(item)}>{item === 'magic' ? 'Magic Select' : item}</button>)}
          {tool === 'brush' && <label>Color <input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>}
          {(tool === 'brush' || tool === 'eraser') && <><label>Size <input type="range" min="1" max="100" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /><span>{brushSize}</span></label><label>Opacity <input type="range" min="0.05" max="1" step="0.05" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /></label></>}
          {tool === 'magic' && <><label>Match <input type="range" min="0" max="128" value={magicTolerance} onChange={(event) => { const value = Number(event.target.value); setMagicTolerance(value); renderMagicSelection(value); }} /><span>{magicTolerance}</span></label><button disabled={!magicPixels} onClick={deleteMagicPixels}>Delete pixels{magicPixels ? ` (${magicPixels.toLocaleString()})` : ''}</button></>}
          <span className="canvas-size-readout">{CANVAS_WIDTH} × {CANVAS_HEIGHT} px</span><div className="canvas-zoom-controls"><button aria-label="Zoom out" onClick={() => changeZoom(zoom / 1.2)}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => changeZoom(zoom * 1.2)}>+</button><button aria-label="Fit image" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Fit</button></div>
          <button disabled={historyIndex.current <= 0} onClick={() => void undo()}>Undo</button><button disabled={historyIndex.current >= history.current.length - 1} onClick={() => void redo()}>Redo</button>
          <button disabled={saving} onClick={() => void saveImage()}>{saving ? 'Saving…' : 'Save WebP'}</button><button className="danger" onClick={() => setClearOpen(true)}>Clear</button>
        </div>
        <div className="canvas-body">
          <div ref={viewport} className="canvas-viewport" data-canvas-dropzone onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={(event) => void drop(event)}>
            <div className="canvas-stage"><div className="canvas-paper" style={{ width: fitSize.width * zoom, height: fitSize.height * zoom, transform: `translate3d(${pan.x}px, ${pan.y}px, 0)` }}>
              <canvas ref={element} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
              <canvas ref={paint} className={`canvas-paint-layer tool-${tool}`} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} onPointerDown={beginPaint} onPointerMove={movePaint} onPointerUp={endPaint} onPointerCancel={endPaint} />
              <canvas ref={magicOverlay} className="canvas-magic-overlay" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
              <canvas ref={composite} className="canvas-composite" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
            </div></div>
            {(uploading || busyMessage) && <div className="canvas-busy">{busyMessage || 'Adding images…'}</div>}
          </div>
          <aside className="canvas-layers"><header><strong>Layers</strong><button disabled={!selectedId} onClick={() => void duplicateSelected()}>Duplicate</button><button disabled={!selectedId} onClick={removeSelected}>Delete</button></header>
            <div className="canvas-layer-list">{[...layers].reverse().map((layer) => <button key={layer.id} className={selectedId === layer.id ? 'active' : ''} onClick={() => {
              const object = fabric.current!.getObjects().find((item) => layerId(item) === layer.id); if (object) { fabric.current!.setActiveObject(object); fabric.current!.requestRenderAll(); setSelectedId(layer.id); }
            }}><span className="layer-name">{layer.name}</span><span className="layer-actions"><i onClick={(event) => { event.stopPropagation(); toggleVisible(layer.id); }}>{layer.visible ? '◉' : '○'}</i><i onClick={(event) => { event.stopPropagation(); reorder(layer.id, 1); }}>↑</i><i onClick={(event) => { event.stopPropagation(); reorder(layer.id, -1); }}>↓</i></span></button>)}</div>
            <div className="paint-layer-label">Paint layer · always on top</div>
          </aside>
        </div>
      </div>
    </FloatingWindow>
    {clearOpen && <div className="shell-modal-backdrop"><div className="shell-modal" role="dialog" aria-modal="true"><h2>Clear Image Editor?</h2><p>This removes every image and brush stroke. You can undo it until the page is reloaded.</p><div><button onClick={clear}>Clear Image Editor</button><button className="ghost" onClick={() => setClearOpen(false)}>Cancel</button></div></div></div>}
  </div>;
});

function layerId(object?: FabricObject) { return object ? String((object as any).canvasLayerId || '') || undefined : undefined; }
function layerFromObject(object: FabricObject): CanvasImageLayer | undefined {
  const id = layerId(object); const path = String((object as any).workspacePath || ''); if (!id || !path) return undefined;
  return { id, name: String((object as any).layerName || path.split('/').pop() || 'Image'), path, left: object.left, top: object.top, scaleX: object.scaleX, scaleY: object.scaleY, angle: object.angle, opacity: object.opacity, visible: object.visible, editedData: typeof (object as any).editedData === 'string' ? (object as any).editedData : undefined };
}
async function objectForPath(path: string, id: string, placement?: CanvasPlacement, editedData?: string) {
  const source = editedData ? await imageCanvasFromData(editedData) : await frozenImage(path); const image = new FabricImage(source); const naturalWidth = source.width || 1;
  const width = placement?.width || Math.min(CANVAS_WIDTH * .7, naturalWidth); const scale = width / naturalWidth;
  const renderedHeight = (source.height || 1) * scale; const left = placement?.x ?? (CANVAS_WIDTH - width) / 2; const top = placement?.y ?? (CANVAS_HEIGHT - renderedHeight) / 2;
  image.set({ left: clamp(left, 0, CANVAS_WIDTH - 8), top: clamp(top, 0, CANVAS_HEIGHT - 8), scaleX: scale, scaleY: scale, cornerColor: '#7cf3ce', borderColor: '#7cf3ce', transparentCorners: false });
  (image as any).canvasLayerId = id; (image as any).workspacePath = path; (image as any).layerName = path.split('/').pop() || 'Image'; if (editedData) (image as any).editedData = editedData; return image;
}
async function objectFromLayer(layer: CanvasImageLayer) {
  const image = await objectForPath(layer.path, layer.id, { x: layer.left, y: layer.top }, layer.editedData);
  image.set({ left: layer.left, top: layer.top, scaleX: layer.scaleX, scaleY: layer.scaleY, angle: layer.angle, opacity: layer.opacity, visible: layer.visible }); (image as any).layerName = layer.name; return image;
}
async function frozenImage(path: string) {
  const response = await fetch(rawFileUrl(path), { cache: 'no-store' }); if (!response.ok) return missingImage(path);
  const blob = await response.blob();
  try {
    const bitmap = await createImageBitmap(blob); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close(); return canvas;
  } catch { return await imageElement(blob); }
}
function missingImage(path: string) {
  const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 200; const context = canvas.getContext('2d')!; context.fillStyle = '#252c37'; context.fillRect(0, 0, canvas.width, canvas.height); context.strokeStyle = '#ff6b7c'; context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16); context.fillStyle = '#ffd9de'; context.font = '16px system-ui'; context.textAlign = 'center'; context.fillText('Missing workspace image', 180, 86); context.font = '12px monospace'; context.fillText(path.slice(-42), 180, 116); return canvas;
}
function imageElement(blob: Blob) { return new Promise<HTMLImageElement>((resolve, reject) => { const url = URL.createObjectURL(blob); const image = new Image(); image.onload = () => { URL.revokeObjectURL(url); resolve(image); }; image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The browser could not decode this image.')); }; image.src = url; }); }
async function imageCanvasFromData(data: string) { const image = await imageElement(await fetch(data).then((response) => response.blob())); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); return canvas; }
function sourceCanvasForImage(image: FabricImage) {
  const source = image.getElement(); const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Number((source as any).naturalWidth || (source as any).videoWidth || (source as any).width || image.width)); canvas.height = Math.max(1, Number((source as any).naturalHeight || (source as any).videoHeight || (source as any).height || image.height));
  canvas.getContext('2d')!.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height); return canvas;
}
function matchingMask(source: HTMLCanvasElement, target: [number, number, number], tolerance: number) {
  const pixels = source.getContext('2d')!.getImageData(0, 0, source.width, source.height); const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height; const context = canvas.getContext('2d')!; const highlight = context.createImageData(source.width, source.height); let count = 0;
  for (let offset = 0; offset < pixels.data.length; offset += 4) if (matchesColor(pixels.data, offset, target, tolerance)) { highlight.data[offset] = 27; highlight.data[offset + 1] = 235; highlight.data[offset + 2] = 255; highlight.data[offset + 3] = 150; count++; }
  context.putImageData(highlight, 0, 0); return { canvas, count };
}
function matchesColor(data: Uint8ClampedArray, offset: number, target: [number, number, number], tolerance: number) { return data[offset + 3] > 0 && Math.max(Math.abs(data[offset] - target[0]), Math.abs(data[offset + 1] - target[1]), Math.abs(data[offset + 2] - target[2])) <= tolerance; }
async function replaceLayers(canvas: FabricCanvas, layers: CanvasImageLayer[], onError: (message: string) => void) {
  canvas.clear();
  for (const layer of layers) try { canvas.add(await objectFromLayer(layer)); } catch (error) { onError((error as Error).message); }
  canvas.requestRenderAll();
}
async function loadPaint(canvas: HTMLCanvasElement, dataUrl: string) { canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height); if (!dataUrl) return; const image = await imageElement(await fetch(dataUrl).then((response) => response.blob())); canvas.getContext('2d')!.drawImage(image, 0, 0); }
async function loadPaintBlob(canvas: HTMLCanvasElement, blob?: Blob) { canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height); if (!blob) return; const image = await imageElement(blob); canvas.getContext('2d')!.drawImage(image, 0, 0); }
function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) { return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality)); }
function isImagePath(path: string) { return /\.(?:png|jpe?g|webp|gif|svg)$/i.test(path); }
function isTypingTarget(target: EventTarget | null) { const element = target as HTMLElement | null; return !!element?.closest('input, textarea, select, [contenteditable="true"]'); }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }
