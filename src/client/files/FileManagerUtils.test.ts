import { describe, expect, it } from 'vitest';
import { DEFAULT_FILE_MANAGER_VIEW, formatFileSize, parseFileManagerView, sortWorkspaceNodes, validateFileName } from './FileManagerUtils';

describe('file manager view helpers', () => {
  it('sorts folders first and files by the selected field', () => {
    const nodes: any[] = [
      { name: 'large.txt', path: 'large.txt', kind: 'file', size: 500 },
      { name: 'z-folder', path: 'z-folder', kind: 'directory' },
      { name: 'small.txt', path: 'small.txt', kind: 'file', size: 10 },
      { name: 'a-folder', path: 'a-folder', kind: 'directory' },
    ];
    expect(sortWorkspaceNodes(nodes, { sortField: 'size', sortDirection: 'asc', showSizes: false }).map((node) => node.name)).toEqual(['a-folder', 'z-folder', 'small.txt', 'large.txt']);
    expect(sortWorkspaceNodes(nodes, { sortField: 'name', sortDirection: 'desc', showSizes: false }).map((node) => node.name)).toEqual(['z-folder', 'a-folder', 'small.txt', 'large.txt']);
  });

  it('formats sizes and safely restores persisted preferences', () => {
    expect(formatFileSize(0)).toBe('0 B'); expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(parseFileManagerView('{"sortField":"modified","sortDirection":"desc","showSizes":true}')).toEqual({ sortField: 'modified', sortDirection: 'desc', showSizes: true });
    expect(parseFileManagerView('broken')).toEqual(DEFAULT_FILE_MANAGER_VIEW);
  });

  it('validates portable file names', () => {
    expect(validateFileName('notes.md')).toBe('');
    expect(validateFileName('../notes.md')).toMatch(/separators/i);
    expect(validateFileName('CON')).toMatch(/reserved/i);
  });
});
