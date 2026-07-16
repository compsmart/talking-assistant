import type { AgentSecretMetadata } from '../../shared/protocol.js';

export interface SecretStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

export class SecretVault {
  constructor(private readonly store: SecretStore, private readonly service = 'cowork-agent-secrets') {}

  static async system(service?: string) {
    const moduleName = '@napi-rs/keyring';
    let keyring: any;
    try { keyring = await import(moduleName); }
    catch { throw unavailable('The operating-system credential manager is unavailable. Secrets were not stored.'); }
    const Entry = keyring.Entry || keyring.default?.Entry;
    if (!Entry) throw unavailable('The credential-manager adapter is incompatible. Secrets were not stored.');
    const adapter: SecretStore = {
      get: async (namespace, account) => new Entry(namespace, account).getPassword(),
      set: async (namespace, account, value) => { await new Entry(namespace, account).setPassword(value); },
      delete: async (namespace, account) => Boolean(await new Entry(namespace, account).deletePassword()),
    };
    return new SecretVault(adapter, service);
  }

  async put(metadata: Pick<AgentSecretMetadata, 'id'>, value: string) {
    if (!value) throw invalid('Secret values cannot be empty.');
    if (value.length > 32_768) throw invalid('Secret values must be at most 32 KiB.');
    await this.store.set(this.service, metadata.id, value);
  }

  async read(secretId: string) {
    const value = await this.store.get(this.service, secretId);
    if (value === null) throw missing(`Secret value is not available: ${secretId}`);
    return value;
  }

  async has(secretId: string) { return (await this.store.get(this.service, secretId)) !== null; }
  async delete(secretId: string) { return this.store.delete(this.service, secretId); }
}

function error(message: string, status: number) { const value = new Error(message) as Error & { status?: number }; value.status = status; return value; }
function invalid(message: string) { return error(message, 400); }
function missing(message: string) { return error(message, 404); }
function unavailable(message: string) { return error(message, 503); }
