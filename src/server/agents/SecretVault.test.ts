import { describe, expect, it } from 'vitest';
import { SecretVault, type SecretStore } from './SecretVault.js';

describe('agent secret vault', () => {
  it('supports opaque put, read, presence, and delete operations', async () => {
    const values = new Map<string, string>();
    const store: SecretStore = {
      get: async (service, account) => values.get(`${service}:${account}`) ?? null,
      set: async (service, account, value) => { values.set(`${service}:${account}`, value); },
      delete: async (service, account) => values.delete(`${service}:${account}`),
    };
    const vault = new SecretVault(store, 'test');
    await vault.put({ id: 'one' }, 'private'); expect(await vault.has('one')).toBe(true); expect(await vault.read('one')).toBe('private');
    expect(await vault.delete('one')).toBe(true); await expect(vault.read('one')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects empty and oversized values before calling the keychain', async () => {
    const store: SecretStore = { get: async () => null, set: async () => { throw new Error('should not run'); }, delete: async () => false };
    const vault = new SecretVault(store);
    await expect(vault.put({ id: 'one' }, '')).rejects.toMatchObject({ status: 400 });
    await expect(vault.put({ id: 'one' }, 'x'.repeat(32_769))).rejects.toMatchObject({ status: 400 });
  });
});
