import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

import {
  exportCredentials,
  importCredentials,
  importCredentialsViaApi,
  CredentialError,
} from '../credentials';
import { encrypt } from '../encrypt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PASSPHRASE = 'test-passphrase-1234';
const SAMPLE_CREDS_JSON = JSON.stringify([
  { id: 'cred-1', name: 'My API Key', type: 'httpHeaderAuth', data: { value: 'secret' } },
]);

/** Build a mock spawnSync return for a successful command with optional stdout. */
function mockSuccess(stdout = ''): ReturnType<typeof childProcess.spawnSync> {
  return {
    pid: 1,
    output: [null, Buffer.from(stdout), Buffer.from('')],
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    status: 0,
    signal: null,
    error: undefined,
  };
}

/** Build a mock spawnSync return for a failed command. */
function mockFailure(code = 1, stderr = 'error'): ReturnType<typeof childProcess.spawnSync> {
  return {
    pid: 1,
    output: [null, Buffer.from(''), Buffer.from(stderr)],
    stdout: Buffer.from(''),
    stderr: Buffer.from(stderr),
    status: code,
    signal: null,
    error: undefined,
  };
}

// ---------------------------------------------------------------------------
// exportCredentials
// ---------------------------------------------------------------------------

describe('exportCredentials', () => {
  beforeEach(() => {
    vi.mocked(childProcess.spawnSync)
      // Call 1: docker exec ... n8n export:credentials (writes to container tmp file)
      .mockReturnValueOnce(mockSuccess())
      // Call 2: docker exec ... cat (reads file from container)
      .mockReturnValueOnce(mockSuccess(SAMPLE_CREDS_JSON))
      // Call 3: docker exec ... rm (cleanup)
      .mockReturnValueOnce(mockSuccess());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls docker exec with correct arguments for export', async () => {
    await exportCredentials('my-n8n', PASSPHRASE);

    const calls = vi.mocked(childProcess.spawnSync).mock.calls;
    expect(calls[0][0]).toBe('docker');
    expect(calls[0][1]).toContain('exec');
    expect(calls[0][1]).toContain('my-n8n');
    expect(calls[0][1]).toContain('n8n');
    expect(calls[0][1]).toContain('export:credentials');
    expect(calls[0][1]).toContain('--decrypted');
  });

  it('reads the output file from the container', async () => {
    await exportCredentials('my-n8n', PASSPHRASE);

    const calls = vi.mocked(childProcess.spawnSync).mock.calls;
    expect(calls[1][1]).toContain('cat');
  });

  it('always cleans up the container temp file', async () => {
    await exportCredentials('my-n8n', PASSPHRASE);

    const calls = vi.mocked(childProcess.spawnSync).mock.calls;
    expect(calls[2][1]).toContain('rm');
    expect(calls[2][1]).toContain('-f');
  });

  it('returns an encrypted buffer (not plaintext)', async () => {
    const result = await exportCredentials('my-n8n', PASSPHRASE);

    // Should NOT be the plaintext JSON
    expect(result.encrypted.toString()).not.toContain('secret');
    // Should be a Buffer larger than the header (60 bytes)
    expect(result.encrypted.length).toBeGreaterThan(60);
  });

  it('returns credential metadata with id, name, type — no secrets', async () => {
    const result = await exportCredentials('my-n8n', PASSPHRASE);

    expect(result.meta).toHaveLength(1);
    expect(result.meta[0]).toEqual({ id: 'cred-1', name: 'My API Key', type: 'httpHeaderAuth' });
    expect(JSON.stringify(result.meta)).not.toContain('secret');
  });

  it('cleans up container temp file even if encrypt throws', async () => {
    // Make cat return empty output — encrypt will throw on empty plaintext
    vi.mocked(childProcess.spawnSync)
      .mockReset()
      .mockReturnValueOnce(mockSuccess())   // export
      .mockReturnValueOnce(mockSuccess('')) // cat returns empty
      .mockReturnValueOnce(mockSuccess());  // rm

    await expect(exportCredentials('my-n8n', PASSPHRASE)).rejects.toThrow(CredentialError);

    // rm should still have been called
    const calls = vi.mocked(childProcess.spawnSync).mock.calls;
    const rmCall = calls.find((c) => c[1].includes('rm'));
    expect(rmCall).toBeDefined();
  });

  it('throws CredentialError if docker exec fails', async () => {
    vi.mocked(childProcess.spawnSync)
      .mockReset()
      .mockReturnValueOnce(mockFailure(1, 'container not found'))
      .mockReturnValueOnce(mockSuccess()); // rm cleanup

    await expect(exportCredentials('bad-container', PASSPHRASE)).rejects.toThrow(
      CredentialError
    );
  });

  it('throws CredentialError if export produces invalid JSON', async () => {
    vi.mocked(childProcess.spawnSync)
      .mockReset()
      .mockReturnValueOnce(mockSuccess())           // export
      .mockReturnValueOnce(mockSuccess('not-json')) // cat returns invalid JSON
      .mockReturnValueOnce(mockSuccess());           // rm

    await expect(exportCredentials('my-n8n', PASSPHRASE)).rejects.toThrow(CredentialError);
  });
});

// ---------------------------------------------------------------------------
// importCredentials
// ---------------------------------------------------------------------------

describe('importCredentials', () => {
  let encryptedCreds: Buffer;

  beforeEach(async () => {
    encryptedCreds = encrypt(Buffer.from(SAMPLE_CREDS_JSON), PASSPHRASE);

    vi.mocked(childProcess.spawnSync)
      // Call 1: docker cp — copies host temp file into container
      .mockReturnValueOnce(mockSuccess())
      // Call 2: docker exec --user root chmod 644 — n8n runs non-root, cp sets owner to root
      .mockReturnValueOnce(mockSuccess())
      // Call 3: docker exec n8n import:credentials
      .mockReturnValueOnce(mockSuccess())
      // Call 4: docker exec --user root rm — cleanup (docker cp sets owner to root)
      .mockReturnValueOnce(mockSuccess());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls docker cp to copy the credentials file into the container', async () => {
    await importCredentials('my-n8n', encryptedCreds, PASSPHRASE);

    const calls = vi.mocked(childProcess.spawnSync).mock.calls;
    expect(calls[0][0]).toBe('docker');
    expect(calls[0][1]).toContain('cp');
    // Container name is embedded in the destination arg: "my-n8n:/tmp/flowsave_xxx.json"
    const destArg = calls[0][1].find((a) => String(a).includes('my-n8n'));
    expect(destArg).toBeDefined();
  });

  it('calls docker exec to run n8n import:credentials', async () => {
    await importCredentials('my-n8n', encryptedCreds, PASSPHRASE);

    const calls = vi.mocked(childProcess.spawnSync).mock.calls;
    const importCall = calls.find(
      (c) => Array.isArray(c[1]) && c[1].includes('exec') && c[1].includes('import:credentials')
    );
    expect(importCall).toBeDefined();
  });

  it('always cleans up the container temp file', async () => {
    await importCredentials('my-n8n', encryptedCreds, PASSPHRASE);

    const calls = vi.mocked(childProcess.spawnSync).mock.calls;
    const rmCall = calls.find((c) => Array.isArray(c[1]) && c[1].includes('rm'));
    expect(rmCall).toBeDefined();
  });

  it('runs chmod 644 as root after docker cp so n8n (non-root user) can read the file', async () => {
    await importCredentials('my-n8n', encryptedCreds, PASSPHRASE);

    const calls = vi.mocked(childProcess.spawnSync).mock.calls;
    const chmodCall = calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('chmod')
    );
    expect(chmodCall).toBeDefined();
    expect(chmodCall?.[1]).toContain('--user');
    expect(chmodCall?.[1]).toContain('root');
    expect(chmodCall?.[1]).toContain('644');
  });

  it('cleans up container temp file using --user root (docker cp sets owner to root)', async () => {
    await importCredentials('my-n8n', encryptedCreds, PASSPHRASE);

    const calls = vi.mocked(childProcess.spawnSync).mock.calls;
    const rmCall = calls.find(
      (c) =>
        Array.isArray(c[1]) &&
        (c[1] as string[]).includes('rm') &&
        (c[1] as string[]).includes('--user') &&
        (c[1] as string[]).includes('root')
    );
    expect(rmCall).toBeDefined();
    expect(rmCall?.[1]).toContain('-f');
  });

  it('throws EncryptionError if passphrase is wrong', async () => {
    await expect(
      importCredentials('my-n8n', encryptedCreds, 'wrong-passphrase')
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// importCredentials — permission error hint
// ---------------------------------------------------------------------------

describe('runDockerCommand permission error hint', () => {
  beforeEach(() => {
    // vi.clearAllMocks() (used in sibling describe blocks) does NOT drain the
    // mockReturnValueOnce queue — reset here so stale return values don't leak
    // into these tests.
    vi.mocked(childProcess.spawnSync).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('includes sudo usermod hint when docker fails with permission denied', async () => {
    vi.mocked(childProcess.spawnSync)
      .mockReturnValueOnce(
        mockFailure(1, 'Got permission denied while trying to connect to the Docker daemon socket')
      )
      .mockReturnValueOnce(mockSuccess()); // rm cleanup

    const err = await exportCredentials('my-n8n', PASSPHRASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialError);
    expect((err as CredentialError).message).toContain('docker group');
    expect((err as CredentialError).message).toContain('usermod');
  });

  it('does NOT add the sudo hint when the failure is unrelated to permissions', async () => {
    vi.mocked(childProcess.spawnSync)
      .mockReturnValueOnce(mockFailure(1, 'container not found'))
      .mockReturnValueOnce(mockSuccess()); // rm cleanup

    const err = await exportCredentials('my-n8n', PASSPHRASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialError);
    expect((err as CredentialError).message).not.toContain('usermod');
  });
});

// ---------------------------------------------------------------------------
// importCredentialsViaApi
// ---------------------------------------------------------------------------

describe('importCredentialsViaApi', () => {
  const TWO_CREDS_JSON = JSON.stringify([
    { id: 'c1', name: 'API Key', type: 'httpHeaderAuth', data: { value: 'secret1' } },
    { id: 'c2', name: 'OAuth Token', type: 'oAuth2Api', data: { token: 'tok' } },
  ]);

  let encryptedTwo: Buffer;

  beforeEach(() => {
    encryptedTwo = encrypt(Buffer.from(TWO_CREDS_JSON), PASSPHRASE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns success result for every credential when all import without error', async () => {
    const mockClient = {
      createCredential: vi.fn().mockResolvedValue({ id: 'new-1', name: 'API Key', type: 'httpHeaderAuth' }),
    };

    const results = await importCredentialsViaApi(encryptedTwo, PASSPHRASE, mockClient as never);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
    expect(results[0].name).toBe('API Key');
    expect(results[1].name).toBe('OAuth Token');
  });

  it('returns failure result for a credential when createCredential throws', async () => {
    const mockClient = {
      createCredential: vi
        .fn()
        .mockResolvedValueOnce({ id: 'new-1' })
        .mockRejectedValueOnce(new Error('Schema validation failed: additionalProperties')),
    };

    const results = await importCredentialsViaApi(encryptedTwo, PASSPHRASE, mockClient as never);

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[1].error).toBeTruthy();
    expect(results[1].name).toBe('OAuth Token');
  });

  it('continues importing remaining credentials after one fails — no all-or-nothing abort', async () => {
    const mockClient = {
      createCredential: vi
        .fn()
        .mockRejectedValueOnce(new Error('validation error'))
        .mockResolvedValueOnce({ id: 'new-2' }),
    };

    const results = await importCredentialsViaApi(encryptedTwo, PASSPHRASE, mockClient as never);

    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
    expect(mockClient.createCredential).toHaveBeenCalledTimes(2);
  });

  it('returns all-failed results when every credential fails', async () => {
    const mockClient = {
      createCredential: vi.fn().mockRejectedValue(new Error('validation error')),
    };

    const results = await importCredentialsViaApi(encryptedTwo, PASSPHRASE, mockClient as never);

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.success)).toBe(true);
  });

  it('throws when passphrase is wrong (EncryptionError before any API call)', async () => {
    const mockClient = { createCredential: vi.fn() };

    await expect(
      importCredentialsViaApi(encryptedTwo, 'wrong-passphrase', mockClient as never)
    ).rejects.toThrow();

    expect(mockClient.createCredential).not.toHaveBeenCalled();
  });

  it('throws CredentialError when decrypted content is not valid JSON', async () => {
    const badEncrypted = encrypt(Buffer.from('not-valid-json'), PASSPHRASE);
    const mockClient = { createCredential: vi.fn() };

    await expect(
      importCredentialsViaApi(badEncrypted, PASSPHRASE, mockClient as never)
    ).rejects.toThrow(CredentialError);

    expect(mockClient.createCredential).not.toHaveBeenCalled();
  });

  it('throws CredentialError when decrypted JSON is not an array', async () => {
    const objEncrypted = encrypt(Buffer.from('{"id":"1","name":"x"}'), PASSPHRASE);
    const mockClient = { createCredential: vi.fn() };

    await expect(
      importCredentialsViaApi(objEncrypted, PASSPHRASE, mockClient as never)
    ).rejects.toThrow(CredentialError);
  });

  it('truncates error messages to 300 chars + ellipsis to avoid log flooding', async () => {
    const longError = 'x'.repeat(500);
    const singleCred = encrypt(
      Buffer.from(JSON.stringify([{ id: 'c1', name: 'A', type: 'httpHeaderAuth', data: {} }])),
      PASSPHRASE
    );
    const mockClient = {
      createCredential: vi.fn().mockRejectedValue(new Error(longError)),
    };

    const [result] = await importCredentialsViaApi(singleCred, PASSPHRASE, mockClient as never);

    expect(result.success).toBe(false);
    expect(result.error?.length ?? 0).toBeLessThanOrEqual(304); // 300 chars + '…'
    expect(result.error?.endsWith('…')).toBe(true);
  });

  it('does not expose the passphrase in error messages', async () => {
    const mockClient = {
      createCredential: vi.fn().mockRejectedValue(new Error('api error')),
    };

    const results = await importCredentialsViaApi(encryptedTwo, PASSPHRASE, mockClient as never);

    for (const r of results) {
      expect(r.error ?? '').not.toContain(PASSPHRASE);
    }
  });
});
