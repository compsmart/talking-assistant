export class WorkspaceMutationLock {
  private owner = '';

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
    finally { this.owner = ''; }
  }
}
