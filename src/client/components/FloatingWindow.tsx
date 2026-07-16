import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

export interface WindowRect { x: number; y: number; width: number; height: number }

interface Props {
  id: string;
  title: string;
  initial: WindowRect;
  minWidth?: number;
  minHeight?: number;
  className?: string;
  children: ReactNode;
  toolbar?: ReactNode;
  headerActions?: ReactNode;
  resizable?: boolean;
  resizeDirections?: readonly ResizeDirection[];
  onClose?: () => void;
}

const STORAGE_PREFIX = 'cowork-layout-v1:';
type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
const RESIZE_DIRECTIONS: ResizeDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

function clampRect(rect: WindowRect): WindowRect {
  const width = Math.min(rect.width, Math.max(160, window.innerWidth - 16));
  const height = Math.min(rect.height, Math.max(120, window.innerHeight - 16));
  return {
    width,
    height,
    x: Math.min(Math.max(8, rect.x), Math.max(8, window.innerWidth - width - 8)),
    y: Math.min(Math.max(8, rect.y), Math.max(8, window.innerHeight - height - 8)),
  };
}

export function FloatingWindow({ id, title, initial, minWidth = 240, minHeight = 180, className = '', children, toolbar, headerActions, resizable = true, resizeDirections = RESIZE_DIRECTIONS, onClose }: Props) {
  const [rect, setRect] = useState<WindowRect>(() => {
    try { return clampRect(JSON.parse(localStorage.getItem(STORAGE_PREFIX + id) || '') as WindowRect); }
    catch { return clampRect(initial); }
  });
  const operation = useRef<null | { mode: 'drag'; startX: number; startY: number; start: WindowRect } | { mode: 'resize'; direction: ResizeDirection; startX: number; startY: number; start: WindowRect }>(null);

  useEffect(() => {
    const onResize = () => setRect((value) => clampRect(value));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(rect)), [id, rect]);

  const beginDrag = useCallback((event: ReactPointerEvent) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    operation.current = { mode: 'drag', startX: event.clientX, startY: event.clientY, start: rect };
  }, [rect]);

  const beginResize = useCallback((direction: ResizeDirection, event: ReactPointerEvent) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    operation.current = { mode: 'resize', direction, startX: event.clientX, startY: event.clientY, start: rect };
  }, [rect]);

  const move = useCallback((event: ReactPointerEvent) => {
    const op = operation.current;
    if (!op) return;
    const dx = event.clientX - op.startX;
    const dy = event.clientY - op.startY;
    if (op.mode === 'drag') {
      setRect(clampRect({ ...op.start, x: op.start.x + dx, y: op.start.y + dy }));
      return;
    }

    const next = { ...op.start };
    const right = op.start.x + op.start.width;
    const bottom = op.start.y + op.start.height;
    const minimumWidth = Math.min(minWidth, window.innerWidth - 16);
    const minimumHeight = Math.min(minHeight, window.innerHeight - 16);
    if (op.direction.includes('e')) next.width = Math.max(minimumWidth, Math.min(op.start.width + dx, window.innerWidth - op.start.x - 8));
    if (op.direction.includes('s')) next.height = Math.max(minimumHeight, Math.min(op.start.height + dy, window.innerHeight - op.start.y - 8));
    if (op.direction.includes('w')) {
      next.x = Math.max(8, Math.min(op.start.x + dx, right - minimumWidth));
      next.width = right - next.x;
    }
    if (op.direction.includes('n')) {
      next.y = Math.max(8, Math.min(op.start.y + dy, bottom - minimumHeight));
      next.height = bottom - next.y;
    }
    setRect(next);
  }, [minHeight, minWidth]);

  const endOperation = useCallback(() => { operation.current = null; }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => move(event as unknown as ReactPointerEvent);
    const onPointerUp = () => endOperation();
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [endOperation, move]);

  const style: CSSProperties = { transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`, width: rect.width, height: rect.height };
  return (
    <section className={`floating-window ${className}`} style={style} aria-label={title}>
      <header className="window-handle" onPointerDown={beginDrag} onPointerMove={move} onPointerUp={endOperation} onPointerCancel={endOperation}>
        <span className="window-grip" aria-hidden="true">••••••</span>
        <span>{title}</span>
        {headerActions && <div className="window-header-actions" onPointerDown={(event) => event.stopPropagation()}>{headerActions}</div>}
        {onClose && <button className="window-close" aria-label={`Close ${title}`} onPointerDown={(event) => event.stopPropagation()} onClick={onClose}>×</button>}
      </header>
      <div className="window-content">{children}</div>
      {toolbar && <div className="window-toolbar">{toolbar}</div>}
      {resizable && resizeDirections.map((direction) => <button type="button" key={direction} className={`resize-handle resize-${direction}`} aria-label={`Resize ${title} from the ${direction} edge`} onPointerDown={(event) => beginResize(direction, event)} onPointerMove={move} onPointerUp={endOperation} onPointerCancel={endOperation} />)}
    </section>
  );
}
