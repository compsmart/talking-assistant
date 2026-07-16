import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, parse, relative, resolve, sep } from 'node:path';
import type { WorkspaceEdit, WorkspaceFileDocument, WorkspaceFileNode } from '../../shared/protocol.js';
import type { WorkspaceRegistry } from './WorkspaceRegistry.js';

const IGNORED = new Set(['node_modules', '.git', 'dist']);
const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.cjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript', '.jsx': 'text/javascript', '.json': 'application/json',
  '.md': 'text/markdown', '.txt': 'text/plain', '.yml': 'text/yaml', '.yaml': 'text/yaml', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml', '.xml', '.svg', '.sh', '.ps1', '.py', '.java', '.c', '.cpp', '.h', '.toml', '.ini', '.env']);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export class WorkspaceFiles {
  constructor(private readonly registry: WorkspaceRegistry) {}
  private root(workspaceId?: string) { return workspaceId ? this.registry.get(workspaceId).draftDir : this.registry.active().draftDir; }
  async list(path = '.', workspaceId?: string, missingAsEmpty = false): Promise<WorkspaceFileNode[]> {
    if (workspaceId) assertReferencePath(path);
    const root = this.root(workspaceId); const directory = await safeWorkspacePath(root, path, !missingAsEmpty);
    const directoryInfo = await stat(directory).catch((error: NodeJS.ErrnoException) => {
      if (missingAsEmpty && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!directoryInfo) return [];
    if (!directoryInfo.isDirectory()) throw statusError('The requested path is not a directory.', 400);
    const entries = await readdir(directory, { withFileTypes: true });
    const nodes = await Promise.all(entries
      .filter((entry) => !IGNORED.has(entry.name) && !entry.isSymbolicLink())
      .map(async (entry): Promise<WorkspaceFileNode> => {
        const absolute = resolve(directory, entry.name); const info = await stat(absolute);
        const itemPath = relative(root, absolute).replaceAll('\\', '/');
        return { name: entry.name, path: itemPath, kind: entry.isDirectory() ? 'directory' : 'file', ...(entry.isFile() ? fileMetadata(itemPath, info.size, info.mtime.toISOString()) : {}) };
      }));
    return nodes.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1);
  }

  async readText(path: string, workspaceId?: string): Promise<WorkspaceFileDocument> {
    if (workspaceId) assertReferencePath(path);
    const file = await safeWorkspacePath(this.root(workspaceId), path, true); const info = await stat(file);
    if (!info.isFile()) throw statusError('The requested path is not a file.', 400);
    if (info.size > MAX_TEXT_BYTES) throw statusError('Text files larger than 2 MB are read-only.', 413);
    const extension = extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && !isProbablyText(await readFile(file))) throw statusError('This file is binary and cannot be opened as text.', 415);
    const data = await readFile(file);
    return { path, content: data.toString('utf8'), hash: hash(data), size: info.size, modifiedAt: info.mtime.toISOString(), mimeType: mimeFor(path) };
  }

  async raw(path: string, workspaceId?: string) {
    if (workspaceId) assertReferencePath(path);
    const file = await safeWorkspacePath(this.root(workspaceId), path, true); const info = await stat(file);
    if (!info.isFile()) throw statusError('The requested path is not a file.', 400);
    return { data: await readFile(file), mimeType: mimeFor(path), size: info.size };
  }

  async search(query: string, rootPath = '.', workspaceId?: string) {
    if (workspaceId) assertReferencePath(rootPath);
    const needle = query.trim().toLowerCase(); if (!needle) return [];
    const root = this.root(workspaceId); const absoluteRoot = await safeWorkspacePath(root, rootPath, true); const output: Array<{ path: string; line?: number; text?: string }> = [];
    for (const file of await walk(absoluteRoot)) {
      const itemPath = relative(root, file).replaceAll('\\', '/');
      if (itemPath.toLowerCase().includes(needle)) output.push({ path: itemPath });
      if (output.length >= 200) break;
      const info = await stat(file); if (info.size > MAX_TEXT_BYTES || !TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
      for (let index = 0; index < lines.length && output.length < 200; index++) if (lines[index].toLowerCase().includes(needle)) output.push({ path: itemPath, line: index + 1, text: lines[index].slice(0, 500) });
    }
    return output;
  }

  async apply(edits: WorkspaceEdit[], workspaceId?: string) {
    if (!Array.isArray(edits) || !edits.length) throw statusError('At least one workspace edit is required.', 400);
    const root = this.root(workspaceId);
    const changed: string[] = [];
    for (const edit of edits) {
      const exists = await safeWorkspacePath(root, edit.path, false).then((path) => stat(path).then(() => true).catch(() => false));
      const file = await safeWorkspacePath(root, edit.path, false);
      const current = exists ? await readFile(file) : Buffer.from('');
      if (edit.expectedHash && hash(current) !== edit.expectedHash) throw statusError(`${edit.path} changed after it was opened. Reload it before saving.`, 409);
      let content: string;
      if (edit.mode === 'write') content = String(edit.content ?? '');
      else {
        const search = String(edit.search ?? ''); if (!search) throw statusError('Exact replacements require non-empty search text.', 400);
        const source = current.toString('utf8'); if (!source.includes(search)) throw statusError(`Text was not found in ${edit.path}.`, 409);
        content = edit.all ? source.split(search).join(String(edit.replacement ?? '')) : source.replace(search, String(edit.replacement ?? ''));
      }
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, content, 'utf8'); changed.push(edit.path);
    }
    return changed;
  }

  async remove(paths: string[]) {
    if (!Array.isArray(paths) || !paths.length) throw statusError('At least one workspace file is required.', 400);
    const requested = [...new Set(paths.map((path) => String(path).trim()).filter(Boolean))];
    if (!requested.length) throw statusError('At least one workspace file is required.', 400);
    const files = await Promise.all(requested.map(async (path) => {
      const file = await safeWorkspacePath(this.root(), path, true); const info = await stat(file);
      if (!info.isFile()) throw statusError(`Only regular files can be deleted: ${path}`, 400);
      return file;
    }));
    await Promise.all(files.map((file) => rm(file)));
    return requested;
  }

  async createFile(directoryPath: string, name: string) {
    const root = this.root(); const directory = await safeWorkspacePath(root, directoryPath || '.', true);
    if (!(await stat(directory)).isDirectory()) throw statusError('The selected destination is not a directory.', 400);
    const path = workspaceRelative(root, resolve(directory, validateFileName(name))); assertFileManagerDestination(path);
    const file = await safeWorkspacePath(root, path, false);
    try { await writeFile(file, '', { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw statusError(`A file named “${basename(path)}” already exists.`, 409); throw error; }
    return { path };
  }

  async renameFile(path: string, newName: string) {
    assertFileManagerSource(path, false);
    const root = this.root(); const source = await safeWorkspacePath(root, path, true); const info = await stat(source);
    if (!info.isFile()) throw statusError('Only regular files can be renamed.', 400);
    const name = validateFileName(newName); const destinationPath = workspaceRelative(root, resolve(dirname(source), name));
    assertFileManagerDestination(destinationPath);
    if (destinationPath === workspaceRelative(root, source)) throw statusError('The file already has that name.', 409);
    const destination = await safeWorkspacePath(root, destinationPath, false);
    if (await lstat(destination).then(() => true).catch(() => false)) throw statusError(`A file named “${name}” already exists.`, 409);
    await rename(source, destination);
    return { previousPath: path, path: destinationPath };
  }

  async copyFile(sourcePath: string, destinationDirectory: string) {
    assertFileManagerSource(sourcePath, true);
    const root = this.root(); const source = await safeWorkspacePath(root, sourcePath, true); const info = await stat(source);
    if (!info.isFile()) throw statusError('Only regular files can be copied.', 400);
    const directory = await safeWorkspacePath(root, destinationDirectory || '.', true);
    if (!(await stat(directory)).isDirectory()) throw statusError('The selected destination is not a directory.', 400);
    const directoryPath = workspaceRelative(root, directory); assertFileManagerDestination(directoryPath);
    const sourceName = basename(source); const parsed = parse(sourceName);
    for (let copyNumber = 0; copyNumber < 10_000; copyNumber++) {
      const name = copyNumber === 0 ? sourceName : `${parsed.name} copy${copyNumber === 1 ? '' : ` ${copyNumber}`}${parsed.ext}`;
      const path = workspaceRelative(root, resolve(directory, name)); const destination = await safeWorkspacePath(root, path, false);
      try { await copyFile(source, destination, constants.COPYFILE_EXCL); return { sourcePath, path, bytes: info.size }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    throw statusError('Could not find an available name for the copied file.', 409);
  }

  async copyFrom(sourceWorkspaceId: string, sourcePath: string, destinationPath: string) {
    assertReferencePath(sourcePath);
    const source = await safeWorkspacePath(this.root(sourceWorkspaceId), sourcePath, true); const info = await stat(source);
    if (!info.isFile()) throw statusError('Only regular workspace files can be copied.', 400);
    const destination = await safeWorkspacePath(this.root(), destinationPath, false); await mkdir(dirname(destination), { recursive: true }); await copyFile(source, destination);
    return { sourceWorkspaceId, sourcePath, destinationPath, bytes: info.size };
  }
}

function assertReferencePath(path: string) { if (String(path).split(/[\\/]/).some((part) => IGNORED.has(part))) throw statusError('Ignored workspace directories cannot be accessed through a cross-workspace reference.', 403); }

function validateFileName(value: string) {
  const name = String(value || '');
  if (!name || name !== name.trim() || name.length > 255) throw statusError('File names must contain 1 to 255 characters without leading or trailing spaces.', 400);
  if (name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) throw statusError('Enter a valid file name without path separators or reserved characters.', 400);
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || IGNORED.has(name)) throw statusError('That file name is reserved.', 400);
  return name;
}

function assertFileManagerSource(path: string, allowPlanCopy: boolean) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => IGNORED.has(part))) throw statusError('Ignored workspace files cannot be managed here.', 403);
  if (!allowPlanCopy && parts[0] === 'plans') throw statusError('Generated plan files cannot be renamed.', 403);
}

function assertFileManagerDestination(path: string) {
  const parts = String(path).split(/[\\/]/).filter((part) => part && part !== '.');
  if (parts.some((part) => IGNORED.has(part))) throw statusError('Ignored workspace directories cannot be changed here.', 403);
  if (parts[0] === 'plans') throw statusError('The plans directory is managed automatically.', 403);
}

function workspaceRelative(root: string, path: string) { return relative(root, path).replaceAll('\\', '/') || '.'; }

export async function safeWorkspacePath(rootInput: string, input: string, mustExist: boolean) {
  if (!input || input.includes('\0')) throw statusError('Invalid workspace path.', 400);
  const root = await realpath(rootInput); const target = resolve(root, input);
  if (target !== root && !target.startsWith(root + sep)) throw statusError(`Path escapes the project workspace: ${input}`, 400);
  let cursor = target;
  while (cursor !== root) {
    const info = await lstat(cursor).catch(() => null);
    if (info?.isSymbolicLink()) throw statusError(`Symbolic links are not allowed in workspace paths: ${input}`, 400);
    cursor = dirname(cursor);
  }
  if (mustExist) await lstat(target);
  return target;
}

export function mimeFor(path: string) { return MIME[extname(path).toLowerCase()] || 'application/octet-stream'; }
export function previewKindFor(path: string): WorkspaceFileNode['previewKind'] {
  const mime = mimeFor(path); if (mime.startsWith('image/')) return 'image'; if (mime.startsWith('video/')) return 'video'; if (mime.startsWith('audio/')) return 'audio';
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) ? 'text' : 'binary';
}
export function hash(data: Buffer) { return createHash('sha256').update(data).digest('hex'); }
export function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }

function fileMetadata(path: string, size: number, modifiedAt: string) { return { size, modifiedAt, mimeType: mimeFor(path), previewKind: previewKindFor(path) }; }
function isProbablyText(data: Buffer) { return !data.subarray(0, Math.min(data.length, 8000)).includes(0); }
async function walk(root: string): Promise<string[]> {
  const info = await stat(root); if (info.isFile()) return [root]; const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = resolve(root, entry.name); if (entry.isDirectory()) output.push(...await walk(path)); else if (entry.isFile()) output.push(path);
  }
  return output;
}
