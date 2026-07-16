import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AvatarController } from '../avatar/AvatarController';
import { FloatingWindow } from './FloatingWindow';

interface Props { caption: string; captionFading?: boolean; toolbar: ReactNode; headerActions?: ReactNode; onReady: (controller: AvatarController) => void; onError: (message: string) => void }

export function AvatarPanel({ caption, captionFading = false, toolbar, headerActions, onReady, onError }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<AvatarController | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const instance = new AvatarController(canvas.current!);
    controller.current = instance;
    instance.initialize().then(() => onReady(instance)).catch((reason) => {
      const message = String(reason?.message || reason).includes('webgpu') ? 'WebGPU is required. Open the app in a current Chrome or Edge browser.' : `Avatar failed to start: ${reason?.message || reason}`;
      setError(message); onError(message);
    });
    return () => instance.dispose();
  }, [onError, onReady]);

  return (
    <FloatingWindow id="avatar" title="Live cowork" initial={{ x: 28, y: 38, width: 380, height: 430 }} minWidth={260} minHeight={260} className="avatar-window" toolbar={toolbar} headerActions={headerActions} resizeDirections={['se']}>
      {error ? <div className="avatar-error">{error}</div> : <canvas ref={canvas} className="avatar-canvas" onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect(); controller.current?.setPointer(((event.clientX - rect.left) / rect.width) * 2 - 1, ((event.clientY - rect.top) / rect.height) * 2 - 1);
      }} />}
      {caption && <div className={`avatar-caption${captionFading ? ' fading' : ''}`}>{caption}</div>}
    </FloatingWindow>
  );
}
