import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

import { exportCredentials, importCredentials, CredentialError } from '../credentials';
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
      // Call 1: docker cp
      .mockReturnValueOnce(mockSuccess())
      // Call 2: docker exec ... n8n import:credentials
      .mockReturnValueOnce(mockSuccess())
      // Call 3: docker exec ... rm
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
    expect(calls[1][1]).toContain('exec');
    expect(calls[1][1]).toContain('import:credentials');
  });

  it('always cleans up the container temp file', async () => {
    await importCredentials('my-n8n', encryptedCreds, PASSPHRASE);

    const calls = vi.mocked(childProcess.spawnSync).mock.calls;
    const rmCall = calls.find((c) => Array.isArray(c[1]) && c[1].includes('rm'));
    expect(rmCall).toBeDefined();
  });

  it('throws EncryptionError if passphrase is wrong', async () => {
    await expect(
      importCredentials('my-n8n', encryptedCreds, 'wrong-passphrase')
    ).rejects.toThrow();
  });
});
