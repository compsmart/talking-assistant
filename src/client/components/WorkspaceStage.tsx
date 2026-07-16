import { forwardRef, useEffect, useRef } from 'react';
import type { WorkspaceMode, WorkspaceSelection } from '../../shared/protocol';

interface CanvasStatus { compatible: boolean; canvasId?: string; restrictionTarget?: unknown }
interface Props {
  version: string; mode: WorkspaceMode; selectMode?: boolean;
  onSelection?: (selection: WorkspaceSelection) => void; onCanvasStatus?: (status: CanvasStatus) => void;
  onCaptureTarget?: (element: HTMLElement | null) => void; onLoad?: () => void;
  onExternalDrag?: (active: boolean) => void; onExternalFiles?: (files: File[]) => void;
}

export const WorkspaceStage = forwardRef<HTMLIFrameElement, Props>(function WorkspaceStage({ version, mode, selectMode = false, onSelection, onCanvasStatus, onCaptureTarget, onLoad, onExternalDrag, onExternalFiles }, ref) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const setFrame = (node: HTMLIFrameElement | null) => {
    frame.current = node;
    if (typeof ref === 'function') ref(node); else if (ref) ref.current = node;
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'cowork:selection-ready') {
        frame.current.contentWindow?.postMessage({ type: 'cowork:set-select-mode', enabled: selectMode }, '*');
        frame.current.contentWindow?.postMessage({ type: 'cowork:set-workspace-mode', mode }, '*');
      }
      if (event.data?.type === 'cowork:element-selected' && event.data.selection) onSelection?.(event.data.selection as WorkspaceSelection);
      if (event.data?.type === 'cowork:canvas-status') onCanvasStatus?.(event.data as CanvasStatus);
      if (event.data?.type === 'cowork:external-file-drag') onExternalDrag?.(Boolean(event.data.active));
      if (event.data?.type === 'cowork:external-files-dropped' && Array.isArray(event.data.files)) {
        const files = event.data.files.filter((file: unknown): file is File => file instanceof File); if (files.length) onExternalFiles?.(files);
      }
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  }, [mode, onCanvasStatus, onExternalDrag, onExternalFiles, onSelection, selectMode]);
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: 'cowork:set-select-mode', enabled: selectMode }, '*'); }, [selectMode, version]);
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: 'cowork:set-workspace-mode', mode }, '*'); }, [mode, version]);
  return (
    <main ref={onCaptureTarget} className="workspace-stage" id="workspace-capture-target">
      <iframe
        ref={setFrame}
        title="Generated workspace"
        src={`http://127.0.0.1:4174/?v=${encodeURIComponent(version)}`}
        sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-same-origin"
        onLoad={onLoad}
      />
    </main>
  );
});
