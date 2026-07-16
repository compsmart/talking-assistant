import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import type { AssetRecord, WorkspaceFileDocument, WorkspaceFileNode } from '../../shared/protocol';
import { commitWorkspace, copyFile as copyWorkspaceFile, createFile as createWorkspaceFile, deleteFiles, editFiles, listFiles, rawFileUrl, readFile, renameFile as renameWorkspaceFile, searchFiles } from '../files/FileClient';
import { formatFileSize, isPlansDirectory, parentPath, parseFileManagerView, sortWorkspaceNodes, validateFileName, type FileManagerViewPreferences, type FileSortField } from '../files/FileManagerUtils';
import { savePlan } from '../agent/TaskClient';
import { FloatingWindow } from './FloatingWindow';

interface Props {
  focusPath?: string;
  refreshKey: number;
  selectedPaths: string[];
  onSelectedPaths: (paths: string[]) => void;
  onUpload: (files: File[], destination: string) => Promise<{ value: AssetRecord[] }>;
  onExecutePlan: (path: string, expectedHash?: string) => Promise<unknown>;
  onClose: () => void;
  onVersion: (version: string) => void;
  onError: (message: string) => void;
}

type Dialog = 'unsaved' | null;
type TreeRoot = 'project';
type InlineEdit = ({ treeRoot: TreeRoot } & ({ kind: 'create'; directory: string } | { kind: 'rename'; path: string; directory: string }));
type FileMenu = { node: WorkspaceFileNode; treeRoot: TreeRoot; left: number; top: number };
const WORKSPACE_FILE_MIME = 'application/x-cowork-workspace-file';
const VIEW_STORAGE_KEY = 'cowork.file-manager.view';

export function FileManager({ focusPath, refreshKey, selectedPaths, onSelectedPaths, onUpload, onExecutePlan, onClose, onVersion, onError }: Props) {
  const [active, setActive] = useState<WorkspaceFileNode>();
  const [document, setDocument] = useState<WorkspaceFileDocument>();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mutating, setMutating] = useState<'create' | 'rename' | 'paste'>();
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ path: string; line?: number; text?: string }>>([]);
  const [currentDirectory, setCurrentDirectory] = useState('.');
  const [currentTreeRoot, setCurrentTreeRoot] = useState<TreeRoot>('project');
  const [clipboard, setClipboard] = useState<{ path: string; name: string }>();
  const [inlineEdit, setInlineEdit] = useState<InlineEdit>();
  const [inlineName, setInlineName] = useState('');
  const [inlineError, setInlineError] = useState('');
  const [recentPath, setRecentPath] = useState<string>();
  const [fileMenu, setFileMenu] = useState<FileMenu>();
  const [sortOpen, setSortOpen] = useState(false);
  const [managerDropActive, setManagerDropActive] = useState(false);
  const [view, setView] = useState<FileManagerViewPreferences>(() => parseFileManagerView(localStorage.getItem(VIEW_STORAGE_KEY)));
  const actionLog = useRef<string[]>([]);
  const commitQueue = useRef<Promise<void>>(Promise.resolve());
  const deletingRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const dirty = !!document && content !== document.content;
  const isPlan = !!document && /^plans\/.+\.md$/i.test(document.path);
  const operationBusy = saving || deleting || !!mutating;

  const logAndCommit = useCallback((actions: string[]) => {
    actionLog.current.push(...actions);
    const commit = async () => {
      const pending = actionLog.current.splice(0);
      if (!pending.length) return;
      try { await commitWorkspace(pending); }
      catch (error) { actionLog.current.unshift(...pending); throw error; }
    };
    const queued = commitQueue.current.catch(() => undefined).then(commit);
    commitQueue.current = queued;
    void queued.catch((error) => onError((error as Error).message));
    return queued;
  }, [onError]);

  useEffect(() => { localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view)); }, [view]);
  useEffect(() => {
    if (!recentPath) return;
    const timer = window.setTimeout(() => setRecentPath(undefined), 1800);
    return () => window.clearTimeout(timer);
  }, [recentPath]);
  useEffect(() => {
    const closePopovers = (event: PointerEvent) => {
      const target = event.target as Node;
      if (fileMenu && !menuRef.current?.contains(target)) setFileMenu(undefined);
      if (sortOpen && !sortRef.current?.contains(target)) setSortOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setFileMenu(undefined); setSortOpen(false); } };
    window.document.addEventListener('pointerdown', closePopovers); window.document.addEventListener('keydown', closeOnEscape);
    return () => { window.document.removeEventListener('pointerdown', closePopovers); window.document.removeEventListener('keydown', closeOnEscape); };
  }, [fileMenu, sortOpen]);

  const loadPath = useCallback(async (path: string, node?: WorkspaceFileNode) => {
    const previewKind = node?.previewKind || previewKindFor(path);
    const next = node || { name: path.split('/').pop() || path, path, kind: 'file' as const, previewKind };
    setActive(next); setDocument(undefined); setContent('');
    if (previewKind === 'text') {
      setLoading(true);
      try { const file = await readFile(path); setDocument(file); setContent(file.content); }
      catch (error) { onError((error as Error).message); }
      finally { setLoading(false); }
    }
  }, [onError]);

  const openPath = useCallback(async (path: string, node?: WorkspaceFileNode) => {
    if (dirty && active?.path !== path && !window.confirm('Discard the unsaved editor changes and open another file?')) return;
    setCurrentDirectory(parentPath(path)); setFileMenu(undefined); await loadPath(path, node);
  }, [active?.path, dirty, loadPath]);

  useEffect(() => { if (focusPath) void openPath(focusPath); }, [focusPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!query.trim()) { setResults([]); return; }
      searchFiles(query).then(setResults).catch((error) => onError(error.message));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query, onError]);

  const save = async () => {
    if (!document) return false; if (!dirty) return document.hash; setSaving(true);
    try {
      if (isPlan) await savePlan(document.path, content, document.hash);
      else { const result = await editFiles([{ path: document.path, mode: 'write', content, expectedHash: document.hash }]); onVersion(result.version); }
      const refreshed = await readFile(document.path); setDocument(refreshed); setContent(refreshed.content);
      void logAndCommit([`user updated file ${document.path}`]); return refreshed.hash;
    } catch (error) { onError((error as Error).message); return false; }
    finally { setSaving(false); }
  };

  const proceed = async () => {
    if (!document || !isPlan) return; const currentHash = await save(); if (!currentHash) return;
    setSaving(true); try { await onExecutePlan(document.path, currentHash); } catch (error) { onError((error as Error).message); } finally { setSaving(false); }
  };

  const removeSelected = async () => {
    if (deletingRef.current) return;
    const paths = [...selectedPaths]; if (!paths.length) return;
    const target = paths.length === 1 ? `“${paths[0]}”` : `${paths.length} selected files`;
    const unsaved = active && paths.includes(active.path) && dirty ? ' Unsaved editor changes will also be discarded.' : '';
    if (!window.confirm(`Permanently delete ${target}?${unsaved}`)) return;
    deletingRef.current = true; setDeleting(true);
    try {
      const result = await deleteFiles(paths); const removed = new Set(result.value);
      void logAndCommit(result.value.map((path) => `user deleted file ${path}`));
      onVersion(result.version); onSelectedPaths(selectedPaths.filter((path) => !removed.has(path)));
      setResults((items) => items.filter((item) => !removed.has(item.path)));
      setClipboard((value) => value && removed.has(value.path) ? undefined : value);
      if (active && removed.has(active.path)) { setActive(undefined); setDocument(undefined); setContent(''); }
      setLocalRefreshKey((value) => value + 1);
    } catch (error) { onError((error as Error).message); }
    finally { deletingRef.current = false; setDeleting(false); }
  };

  const beginCreate = () => {
    if (operationBusy) return;
    if (isPlansDirectory(currentDirectory)) { onError('The plans directory is managed automatically. Choose another folder.'); return; }
    setInlineEdit({ kind: 'create', directory: currentDirectory, treeRoot: currentTreeRoot }); setInlineName('untitled.txt'); setInlineError(''); setFileMenu(undefined);
  };

  const beginRename = (node: WorkspaceFileNode, treeRoot: TreeRoot) => {
    if (operationBusy || isPlansDirectory(node.path)) return;
    setQuery(''); setCurrentTreeRoot(treeRoot); setCurrentDirectory(parentPath(node.path)); setInlineEdit({ kind: 'rename', path: node.path, directory: parentPath(node.path), treeRoot }); setInlineName(node.name); setInlineError(''); setFileMenu(undefined);
  };

  const cancelInlineEdit = () => { setInlineEdit(undefined); setInlineName(''); setInlineError(''); };
  const submitInlineEdit = async () => {
    if (!inlineEdit || operationBusy) return;
    const validation = validateFileName(inlineName); if (validation) { setInlineError(validation); return; }
    if (inlineEdit.kind === 'rename' && inlineName === inlineEdit.path.split('/').pop()) { cancelInlineEdit(); return; }
    if (inlineEdit.kind === 'create' && dirty && !window.confirm('Discard the unsaved editor changes and open the new file?')) return;
    setInlineError(''); setMutating(inlineEdit.kind);
    try {
      if (inlineEdit.kind === 'create') {
        const result = await createWorkspaceFile(inlineEdit.directory, inlineName); onVersion(result.version);
        const path = result.value.path; void logAndCommit([`user created file ${path}`]); cancelInlineEdit(); setLocalRefreshKey((value) => value + 1); setRecentPath(path);
        await loadPath(path, { name: inlineName, path, kind: 'file', size: 0, previewKind: previewKindFor(path) });
      } else {
        const oldPath = inlineEdit.path; const result = await renameWorkspaceFile(oldPath, inlineName); onVersion(result.version); const path = result.value.path;
        void logAndCommit([`user renamed file ${oldPath} to ${path}`]);
        setActive((value) => value?.path === oldPath ? { ...value, name: inlineName, path } : value);
        setDocument((value) => value?.path === oldPath ? { ...value, path } : value);
        onSelectedPaths(selectedPaths.map((selected) => selected === oldPath ? path : selected));
        setResults((items) => items.map((item) => item.path === oldPath ? { ...item, path } : item));
        setClipboard((value) => value?.path === oldPath ? { path, name: inlineName } : value);
        setCurrentDirectory(parentPath(path)); cancelInlineEdit(); setLocalRefreshKey((value) => value + 1); setRecentPath(path);
      }
    } catch (error) { setInlineError((error as Error).message); }
    finally { setMutating(undefined); }
  };

  const paste = async () => {
    if (!clipboard || operationBusy) return;
    if (isPlansDirectory(currentDirectory)) { onError('The plans directory is managed automatically. Choose another folder.'); return; }
    setMutating('paste');
    try {
      const result = await copyWorkspaceFile(clipboard.path, currentDirectory); onVersion(result.version);
      void logAndCommit([`user copied file ${clipboard.path} to ${result.value.path}`]);
      setLocalRefreshKey((value) => value + 1); setRecentPath(result.value.path);
    } catch (error) { onError((error as Error).message); }
    finally { setMutating(undefined); }
  };

  const openFileMenu = (event: React.MouseEvent<HTMLButtonElement>, node: WorkspaceFileNode, treeRoot: TreeRoot) => {
    event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); const width = 144;
    setFileMenu({ node, treeRoot, left: Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width)), top: rect.bottom + 4 > window.innerHeight - 90 ? rect.top - 76 : rect.bottom + 4 });
  };

  const selectDirectory = (path: string, treeRoot: TreeRoot) => { setCurrentDirectory(path); setCurrentTreeRoot(treeRoot); };

  const finishClose = async () => { try { if (actionLog.current.length) void logAndCommit([]); await commitQueue.current; onClose(); } catch { /* The queued commit reports its own error and keeps the file manager open. */ } };
  const requestClose = async () => { if (dirty) { setDialog('unsaved'); return; } await finishClose(); };
  const saveAndClose = async () => { if (!await save()) return; await finishClose(); };
  const toggleSelected = (path: string) => onSelectedPaths(selectedPaths.includes(path) ? selectedPaths.filter((item) => item !== path) : [...selectedPaths, path]);
  const uploadInto = useCallback(async (files: File[], destination: string) => {
    if (isPlansDirectory(destination)) { onError('The plans directory is managed automatically. Choose another folder.'); return; }
    try {
      const result = await onUpload(files, destination); void logAndCommit(result.value.map((file) => `user uploaded file ${file.path}`));
      setLocalRefreshKey((value) => value + 1); if (result.value[0]) setRecentPath(result.value[0].path);
    } catch (error) { onError((error as Error).message); }
  }, [logAndCommit, onError, onUpload]);
  const extensions = useMemo(() => editorExtensions(active?.path || ''), [active?.path]);
  const treeRefreshKey = refreshKey + localRefreshKey;

  return <>
    <FloatingWindow id="file-manager" title="Workspace Files" initial={{ x: 26, y: 32, width: 820, height: 590 }} minWidth={560} minHeight={360} className="file-manager-window" onClose={() => void requestClose()}>
      <div
        className={`file-manager ${managerDropActive ? 'drop-active' : ''}`}
        onDragEnter={(event) => { if (!hasExternalFiles(event)) return; if (isDirectoryDropTarget(event.target)) { setManagerDropActive(false); return; } event.preventDefault(); setManagerDropActive(true); }}
        onDragOver={(event) => { if (!hasExternalFiles(event)) return; if (isDirectoryDropTarget(event.target)) { setManagerDropActive(false); return; } event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setManagerDropActive(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setManagerDropActive(false); }}
        onDropCapture={() => setManagerDropActive(false)}
        onDrop={(event) => { if (!hasExternalFiles(event)) return; event.preventDefault(); event.stopPropagation(); const files = Array.from(event.dataTransfer.files); if (files.length) void uploadInto(files, currentDirectory); }}
      >
        {managerDropActive && <div className="file-manager-drop-hint">Drop into <strong>{currentDirectory === '.' ? 'Project' : currentDirectory}</strong></div>}
        <aside className="file-sidebar">
          <input className="file-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search project…" aria-label="Search project files" />
          <div className="file-toolbar" aria-label="File tools">
            <button onClick={beginCreate} disabled={operationBusy || isPlansDirectory(currentDirectory)} title="Create a new file"><FileIcon path={icons.newFile} /><span>New</span></button>
            <button onClick={() => void paste()} disabled={!clipboard || operationBusy || isPlansDirectory(currentDirectory)} title={clipboard ? `Paste ${clipboard.name} into ${currentDirectory}` : 'Copy a file before pasting'}><FileIcon path={icons.paste} /><span>{mutating === 'paste' ? 'Pasting…' : 'Paste'}</span></button>
            <div className="file-sort-control" ref={sortRef}>
              <button className={sortOpen ? 'active' : ''} onClick={() => setSortOpen((value) => !value)} aria-expanded={sortOpen} title="Sort files"><FileIcon path={icons.sort} /><span>Sort</span></button>
              {sortOpen && <div className="file-sort-menu" role="dialog" aria-label="Sort files">
                <strong>Sort by</strong>{(['name', 'size', 'modified'] as FileSortField[]).map((field) => <button key={field} className={view.sortField === field ? 'selected' : ''} onClick={() => setView((value) => ({ ...value, sortField: field }))}>{field[0].toUpperCase() + field.slice(1)}{view.sortField === field && <span>✓</span>}</button>)}
                <div className="file-sort-direction"><button className={view.sortDirection === 'asc' ? 'selected' : ''} onClick={() => setView((value) => ({ ...value, sortDirection: 'asc' }))}>Ascending</button><button className={view.sortDirection === 'desc' ? 'selected' : ''} onClick={() => setView((value) => ({ ...value, sortDirection: 'desc' }))}>Descending</button></div>
              </div>}
            </div>
            <button className={view.showSizes ? 'active' : ''} onClick={() => setView((value) => ({ ...value, showSizes: !value.showSizes }))} aria-pressed={view.showSizes} title={view.showSizes ? 'Hide file sizes' : 'Show file sizes'}><FileIcon path={icons.info} /><span>Info</span></button>
          </div>
          <div className="file-current-folder" title={currentDirectory}><FileIcon path={icons.folder} /><span>{currentDirectory === '.' ? 'Project' : currentDirectory}</span></div>
          {query ? <div className="file-results">{results.map((result, index) => {
            const node: WorkspaceFileNode = { name: result.path.split('/').pop() || result.path, path: result.path, kind: 'file', previewKind: previewKindFor(result.path) };
            return <div className={`file-result-item ${active?.path === result.path ? 'active' : ''}`} key={`${result.path}:${result.line}:${index}`}><button className="file-result-open" onClick={() => { setCurrentTreeRoot('project'); void openPath(result.path, node); }}><strong>{result.path}{result.line ? `:${result.line}` : ''}</strong>{result.text && <span>{result.text}</span>}</button><button className="file-row-more" aria-label={`Actions for ${result.path}`} onClick={(event) => openFileMenu(event, node, 'project')}>•••</button></div>;
          })}</div>
            : <div className="file-tree"><TreeDirectory treeRoot="project" activeTreeRoot={currentTreeRoot} path="." label="Project" selected={selectedPaths} active={active?.path} currentDirectory={currentDirectory} view={view} inlineEdit={inlineEdit} inlineName={inlineName} inlineError={inlineError} inlineBusy={!!mutating} recentPath={recentPath} refreshKey={treeRefreshKey} onOpen={openPath} onToggle={toggleSelected} onSelectDirectory={selectDirectory} onInlineName={setInlineName} onSubmitInline={() => void submitInlineEdit()} onCancelInline={cancelInlineEdit} onMenu={openFileMenu} onDropFiles={uploadInto} defaultOpen /></div>}
        </aside>
        <section className="file-viewer">
          <header className="file-viewer-header"><span>{active?.path || 'Select a file'}</span>{active && <label><input type="checkbox" checked={selectedPaths.includes(active.path)} onChange={() => toggleSelected(active.path)} /> Agent context</label>}{!!selectedPaths.length && <button className="danger" disabled={operationBusy} onClick={() => void removeSelected()}>{deleting ? 'Deleting…' : `Delete selected (${selectedPaths.length})`}</button>}{document && <button disabled={!dirty || operationBusy} onClick={() => void save()}>{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>}{isPlan && <button className="proceed" disabled={operationBusy} onClick={() => void proceed()}>Proceed</button>}</header>
          <div className="file-viewer-body">{loading ? <div className="file-empty">Loading…</div> : !active ? <div className="file-empty">Select a project file or drop media onto the workspace.</div> : document ? <CodeMirror value={content} height="100%" theme="dark" extensions={extensions} onChange={setContent} basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true }} /> : <MediaPreview file={active} />}</div>
        </section>
      </div>
    </FloatingWindow>
    {fileMenu && <div ref={menuRef} className="file-row-menu" style={{ left: fileMenu.left, top: fileMenu.top }} role="menu"><button role="menuitem" onClick={() => { setClipboard({ path: fileMenu.node.path, name: fileMenu.node.name }); setFileMenu(undefined); }}><FileIcon path={icons.copy} />Copy</button><button role="menuitem" disabled={operationBusy || isPlansDirectory(fileMenu.node.path)} title={isPlansDirectory(fileMenu.node.path) ? 'Generated plans cannot be renamed' : undefined} onClick={() => beginRename(fileMenu.node, fileMenu.treeRoot)}><FileIcon path={icons.rename} />Rename</button></div>}
    {dialog && <div className="shell-modal-backdrop"><div className="shell-modal" role="dialog" aria-modal="true"><h2>Unsaved changes</h2><p>Save and validate this file before closing the file manager?</p><div><button disabled={saving} onClick={() => void saveAndClose()}>Save and close</button><button className="ghost" onClick={() => { setDocument(undefined); setDialog(null); void finishClose(); }}>Discard</button><button className="ghost" onClick={() => setDialog(null)}>Cancel</button></div></div></div>}
  </>;
}

interface TreeDirectoryProps {
  treeRoot: TreeRoot; activeTreeRoot: TreeRoot; path: string; label: string; selected: string[]; active?: string; currentDirectory: string; view: FileManagerViewPreferences; inlineEdit?: InlineEdit; inlineName: string; inlineError: string; inlineBusy: boolean; recentPath?: string; refreshKey: number;
  onOpen: (path: string, node?: WorkspaceFileNode) => void; onToggle: (path: string) => void; onSelectDirectory: (path: string, treeRoot: TreeRoot) => void; onInlineName: (name: string) => void; onSubmitInline: () => void; onCancelInline: () => void; onMenu: (event: React.MouseEvent<HTMLButtonElement>, node: WorkspaceFileNode, treeRoot: TreeRoot) => void; onDropFiles: (files: File[], destination: string) => Promise<void>; optional?: boolean; defaultOpen?: boolean;
}

function TreeDirectory(props: TreeDirectoryProps) {
  const { treeRoot, activeTreeRoot, path, label, selected, active, currentDirectory, view, inlineEdit, inlineName, inlineError, inlineBusy, recentPath, refreshKey, onOpen, onToggle, onSelectDirectory, onInlineName, onSubmitInline, onCancelInline, onMenu, onDropFiles, optional, defaultOpen = false } = props;
  const [open, setOpen] = useState(defaultOpen); const [children, setChildren] = useState<WorkspaceFileNode[]>([]); const [missing, setMissing] = useState(false); const [dropActive, setDropActive] = useState(false);
  useEffect(() => { if (inlineEdit?.treeRoot === treeRoot && (path === '.' || inlineEdit.directory === path || inlineEdit.directory.startsWith(`${path}/`))) setOpen(true); }, [inlineEdit, path, treeRoot]);
  useEffect(() => { if (!open) return; listFiles(path, optional).then((items) => { setChildren(items); setMissing(Boolean(optional && !items.length)); }).catch(() => { if (optional) { setMissing(true); if (activeTreeRoot === treeRoot && currentDirectory === path) onSelectDirectory('.', 'project'); } }); }, [open, path, refreshKey, optional]); // eslint-disable-line react-hooks/exhaustive-deps
  const sortedChildren = useMemo(() => sortWorkspaceNodes(children, view), [children, view]);
  if (missing) return null;
  const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  return <div className="tree-directory"><button data-file-dropzone className={`tree-directory-label ${dropActive ? 'drop-active' : ''} ${activeTreeRoot === treeRoot && currentDirectory === path ? 'current' : ''}`} onClick={() => { onSelectDirectory(path, treeRoot); setOpen((value) => !value); }} onDragEnter={(event) => { if (!hasFiles(event)) return; event.preventDefault(); setDropActive(true); }} onDragOver={(event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }} onDrop={(event) => { if (!hasFiles(event)) return; event.preventDefault(); event.stopPropagation(); setDropActive(false); onSelectDirectory(path, treeRoot); const files = Array.from(event.dataTransfer.files); if (files.length) void onDropFiles(files, path); }}><span>{open ? '▾' : '▸'}</span>{label}</button>{open && <div className="tree-children">
    {inlineEdit?.treeRoot === treeRoot && inlineEdit.kind === 'create' && inlineEdit.directory === path && <InlineNameEditor value={inlineName} error={inlineError} busy={inlineBusy} onChange={onInlineName} onSubmit={onSubmitInline} onCancel={onCancelInline} />}
    {sortedChildren.map((node) => node.kind === 'directory' ? <TreeDirectory key={node.path} {...props} path={node.path} label={node.name} optional={false} defaultOpen={false} /> : inlineEdit?.treeRoot === treeRoot && inlineEdit.kind === 'rename' && inlineEdit.path === node.path ? <InlineNameEditor key={node.path} value={inlineName} error={inlineError} busy={inlineBusy} onChange={onInlineName} onSubmit={onSubmitInline} onCancel={onCancelInline} /> : <div className={`tree-file ${active === node.path ? 'active' : ''} ${recentPath === node.path ? 'recent' : ''}`} key={node.path}><input type="checkbox" checked={selected.includes(node.path)} onChange={() => onToggle(node.path)} aria-label={`Use ${node.path} as agent context`} /><button className="tree-file-open" draggable={node.previewKind === 'image'} onDragStart={(event) => { if (node.previewKind !== 'image') return; event.dataTransfer.setData(WORKSPACE_FILE_MIME, node.path); event.dataTransfer.setData('text/plain', node.path); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => { onSelectDirectory(parentPath(node.path), treeRoot); onOpen(node.path, node); }}>{iconFor(node.previewKind)}<span className="tree-file-name">{node.name}</span>{view.showSizes && <span className="tree-file-size" title={`${node.size ?? 0} bytes`}>{formatFileSize(node.size)}</span>}</button><button className="file-row-more" aria-label={`Actions for ${node.path}`} onClick={(event) => onMenu(event, node, treeRoot)}>•••</button></div>)}
  </div>}</div>;
}

function InlineNameEditor({ value, error, busy, onChange, onSubmit, onCancel }: { value: string; error: string; busy: boolean; onChange: (value: string) => void; onSubmit: () => void; onCancel: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return <div className={`file-inline-editor ${error ? 'invalid' : ''}`}><input ref={input} value={value} disabled={busy} aria-label="File name" aria-invalid={!!error} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onSubmit(); } if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }} /><button onClick={onSubmit} disabled={busy} aria-label="Confirm file name">✓</button><button onClick={onCancel} disabled={busy} aria-label="Cancel">×</button>{error && <small>{error}</small>}</div>;
}

function MediaPreview({ file }: { file: WorkspaceFileNode }) {
  const source = rawFileUrl(file.path);
  if (file.previewKind === 'image') return <div className="media-preview"><img draggable onDragStart={(event) => { event.dataTransfer.setData(WORKSPACE_FILE_MIME, file.path); event.dataTransfer.setData('text/plain', file.path); event.dataTransfer.effectAllowed = 'copy'; }} src={source} alt={file.name} /><p>{file.name}</p></div>;
  if (file.previewKind === 'video') return <div className="media-preview"><video src={source} controls /><p>{file.name}</p></div>;
  if (file.previewKind === 'audio') return <div className="media-preview"><audio src={source} controls /><p>{file.name}</p></div>;
  return <div className="file-empty">Binary file · {file.name}</div>;
}

const icons = {
  newFile: 'M5 2h9l5 5v15H5zm8 2v5h4M12 12v7m-3.5-3.5h7', paste: 'M8 4h2a2 2 0 0 1 4 0h2v3H8zm-2 2H4v16h16V6h-2v3H6zm3 7h6v2H9zm0 4h6v2H9z',
  sort: 'M7 4h10v2H7zm2 6h6v2H9zm2 6h2v2h-2z', info: 'M11 10h2v8h-2zm0-4h2v2h-2zM12 2a10 10 0 1 1 0 20a10 10 0 0 1 0-20m0 2a8 8 0 1 0 0 16a8 8 0 0 0 0-16',
  folder: 'M3 5h7l2 2h9v12H3z', copy: 'M8 8h12v12H8zm-4-4h12v2H6v10H4z', rename: 'm4 17-.5 3.5L7 20l11-11-2.5-2.5zm13-12 2.5 2.5 1-1a1.8 1.8 0 0 0-2.5-2.5z',
};
function FileIcon({ path }: { path: string }) { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>; }
function hasExternalFiles(event: React.DragEvent) { return Array.from(event.dataTransfer.types).includes('Files'); }
function isDirectoryDropTarget(target: EventTarget | null) { return target instanceof Element && !!target.closest('.tree-directory-label'); }
function previewKindFor(path: string): WorkspaceFileNode['previewKind'] { const extension = path.split('.').pop()?.toLowerCase(); if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension || '')) return 'image'; if (['mp4', 'webm', 'mov'].includes(extension || '')) return 'video'; if (['mp3', 'wav', 'ogg'].includes(extension || '')) return 'audio'; if (['woff', 'woff2', 'ttf', 'ico', 'bin', 'zip'].includes(extension || '')) return 'binary'; return 'text'; }
function iconFor(kind?: WorkspaceFileNode['previewKind']) { return kind === 'image' ? '▧' : kind === 'video' ? '▶' : kind === 'audio' ? '♪' : kind === 'binary' ? '◆' : '·'; }
function editorExtensions(path: string) { const extension = path.split('.').pop()?.toLowerCase(); if (['js', 'jsx', 'mjs', 'cjs'].includes(extension || '')) return [javascript({ jsx: true })]; if (['ts', 'tsx'].includes(extension || '')) return [javascript({ jsx: extension === 'tsx', typescript: true })]; if (['html', 'htm'].includes(extension || '')) return [html()]; if (extension === 'css') return [css()]; if (extension === 'json') return [json()]; if (['md', 'markdown'].includes(extension || '')) return [markdown()]; return []; }
