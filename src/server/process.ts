import { execFile } from 'node:child_process';

export interface CommandResult { code: number; stdout: string; stderr: string }

export function run(executable: string, args: string[], options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(executable, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
      env: options.env || process.env,
    }, (error, stdout, stderr) => resolve({ code: typeof (error as any)?.code === 'number' ? (error as any).code : error ? 1 : 0, stdout: String(stdout), stderr: String(stderr || error?.message || '') }));
  });
}
