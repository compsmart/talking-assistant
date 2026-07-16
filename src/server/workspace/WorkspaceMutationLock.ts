export class WorkspaceMutationLock {
  private owner = '';
  private waiters = new Set<() => void>();

  get busy() { return !!this.owner; }
  get currentOwner() { return this.owner; }

  async run<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    if (this.owner) {
      const error = new Error(`The workspace is busy with ${this.owner}. Try again when it finishes.`) as Error & { status?: number };
      error.status = 409;
      throw error;
    }
    this.owner = owner;
    try { return await operation(); }
    finally { this.release(); }
  }

  async enqueue<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    while (this.owner) await new Promise<void>((resolve) => this.waiters.add(resolve));
    this.owner = owner;
    try { return await operation(); }
    finally { this.release(); }
  }

  private release() { this.owner = ''; const waiters = [...this.waiters]; this.waiters.clear(); for (const notify of waiters) notify(); }
}
