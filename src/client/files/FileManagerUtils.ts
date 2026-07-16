import type { WorkspaceFileNode } from '../../shared/protocol';

export type FileSortField = 'name' | 'size' | 'modified';
export type FileSortDirection = 'asc' | 'desc';

export interface FileManagerViewPreferences {
  sortField: FileSortField;
  sortDirection: FileSortDirection;
  showSizes: boolean;
}

export const DEFAULT_FILE_MANAGER_VIEW: FileManagerViewPreferences = { sortField: 'name', sortDirection: 'asc', showSizes: false };

export function parseFileManagerView(value: string | null): FileManagerViewPreferences {
  try {
    const input = JSON.parse(value || '{}');
    return {
      sortField: ['name', 'size', 'modified'].includes(input.sortField) ? input.sortField : DEFAULT_FILE_MANAGER_VIEW.sortField,
      sortDirection: input.sortDirection === 'desc' ? 'desc' : 'asc',
      showSizes: input.showSizes === true,
    };
  } catch { return { ...DEFAULT_FILE_MANAGER_VIEW }; }
}

export function sortWorkspaceNodes(nodes: WorkspaceFileNode[], view: FileManagerViewPreferences) {
  const direction = view.sortDirection === 'desc' ? -1 : 1;
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    if (a.kind === 'directory') return direction * compareName(a.name, b.name);
    let comparison = 0;
    if (view.sortField === 'size') comparison = (a.size ?? -1) - (b.size ?? -1);
    else if (view.sortField === 'modified') comparison = Date.parse(a.modifiedAt || '') - Date.parse(b.modifiedAt || '');
    else comparison = compareName(a.name, b.name);
    return comparison ? direction * comparison : compareName(a.name, b.name);
  });
}

export function formatFileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes / 1024; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function validateFileName(value: string) {
  if (!value || value !== value.trim() || value.length > 255) return 'Use 1–255 characters without leading or trailing spaces.';
  if (value === '.' || value === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(value) || /[. ]$/.test(value)) return 'Remove path separators or reserved characters.';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || ['node_modules', '.git', 'dist'].includes(value)) return 'That file name is reserved.';
  return '';
}

export function parentPath(path: string) { const parts = path.replaceAll('\\', '/').split('/'); parts.pop(); return parts.join('/') || '.'; }
export function isPlansDirectory(path: string) { return path === 'plans' || path.startsWith('plans/'); }
function compareName(a: string, b: string) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
