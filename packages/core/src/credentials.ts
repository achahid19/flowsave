/**
 * @flowsave/core — Credential export/import via docker exec
 *
 * Credentials CANNOT be exported via the n8n REST API — the API redacts all
 * secret values by design. The only way to get plaintext credential data is
 * via the n8n CLI run inside the container.
 *
 * Security rules enforced here:
 * - Plaintext credentials are NEVER written to a persistent location
 * - Temp files use random UUIDs in their names to avoid collisions
 * - Temp files are ALWAYS deleted in a finally block — not just on success
 * - The passphrase is NEVER logged, stored, or included in error messages
 * - All shell commands use spawnSync with an arg array — no shell injection
 *
 * Docker socket scope:
 * - Used EXCLUSIVELY for `n8n export:credentials` and `n8n import:credentials`
 * - Never used for container inspection, image pulling, or any other operation
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { decrypt, encrypt } from './encrypt';
import type { N8nClient } from './n8nClient';
import type { CredentialImportResult, CredentialMeta } from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a command using spawnSync with an argument array (no shell injection).
 * Throws CredentialError on non-zero exit or spawn failure.
 * stderr is sanitized before inclusion in error messages.
 */
function runDockerCommand(args: string[]): Buffer {
  const result = spawnSync('docker', args, { maxBuffer: 100 * 1024 * 1024 }); // 100 MB

  if (result.error) {
    throw new CredentialError(
      `Failed to run docker command: ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    // n8n writes errors to stdout, not stderr — check both
    const stderr = result.stderr?.toString().trim() ?? '';
    const stdout = result.stdout?.toString().trim() ?? '';
    const details = stderr.length > 0 ? stderr : stdout;
    const safeDetails = details.length > 0
      ? ` (docker: ${details.substring(0, 300)})`
      : '';
    throw new CredentialError(
      `docker command exited with code ${result.status}${safeDetails}`
    );
  }

  return result.stdout ?? Buffer.alloc(0);
}

/** Generate a safe temporary file name with a random UUID. */
function tempFileName(prefix: string, ext: string): string {
  return `${prefix}_${randomUUID()}.${ext}`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export all credentials from an n8n container and return an encrypted buffer.
 *
 * Flow:
 * 1. docker exec → n8n export:credentials → writes JSON inside container
 * 2. docker exec cat → reads the JSON from the container
 * 3. docker exec rm  → deletes the in-container temp file
 * 4. encrypt()       → AES-256-GCM with user's passphrase
 *
 * @param containerName - Docker container name (from config.containerName)
 * @param passphrase    - Encryption passphrase (never logged or stored)
 * @returns Encrypted credentials buffer ready for writing to _credentials.enc.json
 */
export interface ExportCredentialsResult {
  /** AES-256-GCM encrypted credential blob — written to _credentials.enc.json */
  encrypted: Buffer;
  /** Safe metadata (id, name, type only — no secrets) — written to _credentials.meta.json */
  meta: CredentialMeta[];
}

export async function exportCredentials(
  containerName: string,
  passphrase: string
): Promise<ExportCredentialsResult> {
  const containerTmpPath = `/tmp/${tempFileName('flowsave_creds', 'json')}`;

  try {
    // Step 1: export inside the container
    runDockerCommand([
      'exec',
      containerName,
      'n8n',
      'export:credentials',
      '--all',
      '--decrypted',
      `--output=${containerTmpPath}`,
    ]);

    // Step 2: read the file out of the container via stdout
    const plaintextBuffer = runDockerCommand([
      'exec',
      containerName,
      'cat',
      containerTmpPath,
    ]);

    if (plaintextBuffer.length === 0) {
      throw new CredentialError('Credential export produced no output');
    }

    // Step 3: validate JSON and extract safe metadata (no secrets)
    let parsed: Array<{ id: string; name: string; type: string }>;
    try {
      parsed = JSON.parse(plaintextBuffer.toString('utf-8')) as typeof parsed;
    } catch {
      throw new CredentialError('Credential export output is not valid JSON');
    }

    const meta: CredentialMeta[] = parsed.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
    }));

    // Step 4: encrypt with user's passphrase
    const encrypted = encrypt(plaintextBuffer, passphrase);

    return { encrypted, meta };
  } finally {
    // Always clean up the in-container temp file — even if encrypt() threw
    try {
      runDockerCommand(['exec', containerName, 'rm', '-f', containerTmpPath]);
    } catch {
      process.stderr.write(
        `[flowsave] Warning: could not delete temp file ${containerTmpPath} in container ${containerName}\n`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Decrypt an encrypted credentials buffer and import it into an n8n container.
 *
 * Flow:
 * 1. decrypt()     → AES-256-GCM with user's passphrase → plaintext JSON
 * 2. Write plaintext to a host temp file (random name in OS tmpdir)
 * 3. docker cp     → copy host temp file into the container
 * 4. docker exec   → n8n import:credentials from container temp file
 * 5. finally       → delete both host and container temp files
 *
 * @param containerName  - Docker container name
 * @param encryptedData  - Buffer from _credentials.enc.json
 * @param passphrase     - Decryption passphrase
 */
export async function importCredentials(
  containerName: string,
  encryptedData: Buffer,
  passphrase: string
): Promise<void> {
  const hostTmpDir = tmpdir();
  const hostTmpName = tempFileName('flowsave_creds', 'json');
  const hostTmpPath = join(hostTmpDir, hostTmpName);
  const containerTmpPath = `/tmp/${hostTmpName}`;

  // Ensure host tmp dir exists (it always should, but be defensive)
  if (!existsSync(hostTmpDir)) {
    mkdirSync(hostTmpDir, { recursive: true });
  }

  let hostFileWritten = false;

  try {
    // Step 1: decrypt — throws EncryptionError on wrong passphrase or corruption
    const plaintext = decrypt(encryptedData, passphrase);

    // Step 2: write plaintext to host temp file
    writeFileSync(hostTmpPath, plaintext, { mode: 0o600 }); // owner-read-only
    hostFileWritten = true;

    // Step 3: copy from host into container
    runDockerCommand(['cp', hostTmpPath, `${containerName}:${containerTmpPath}`]);

    // Step 3b: docker cp preserves 0o600 from the host and sets owner to root.
    // n8n runs as a non-root user inside the container — chmod so it can read
    // the file. The file is still deleted immediately after import.
    runDockerCommand(['exec', '--user', 'root', containerName, 'chmod', '644', containerTmpPath]);

    // Step 4: import inside container
    runDockerCommand([
      'exec',
      containerName,
      'n8n',
      'import:credentials',
      `--input=${containerTmpPath}`,
    ]);
  } finally {
    // Always clean up host temp file
    if (hostFileWritten && existsSync(hostTmpPath)) {
      try {
        rmSync(hostTmpPath);
      } catch {
        process.stderr.write(
          `[flowsave] Warning: could not delete host temp file ${hostTmpPath}\n`
        );
      }
    }

    // Always clean up container temp file — use root since docker cp sets owner to root
    try {
      runDockerCommand(['exec', '--user', 'root', containerName, 'rm', '-f', containerTmpPath]);
    } catch {
      process.stderr.write(
        `[flowsave] Warning: could not delete container temp file ${containerTmpPath}\n`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// API-based import (cross-instance, no Docker access required)
// ---------------------------------------------------------------------------

/**
 * Decrypt a credentials blob and import each credential into a target n8n
 * instance via the REST API (POST /api/v1/credentials).
 *
 * This path is used for cross-instance restore when Docker is not available on
 * the target machine. Credentials travel decrypted in memory and over TLS —
 * the same security posture as any API call; n8n stores them encrypted on the
 * other end.
 *
 * Known limitation: `n8n export:credentials --decrypted` may include internal
 * fields (e.g. OAuth token state) that some credential type schemas reject with
 * `additionalProperties: false`. Each credential is attempted individually and
 * failures are returned in the result array rather than aborting the whole import.
 *
 * @param encryptedData - Buffer from _credentials.enc.json
 * @param passphrase    - Decryption passphrase (never logged)
 * @param client        - N8nClient pointed at the target instance
 * @returns             Per-credential import results
 */
export async function importCredentialsViaApi(
  encryptedData: Buffer,
  passphrase: string,
  client: N8nClient
): Promise<CredentialImportResult[]> {
  // Step 1: decrypt — throws EncryptionError on wrong passphrase or corruption
  const plaintext = decrypt(encryptedData, passphrase);

  // Step 2: parse credential array
  let credentials: Array<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(plaintext.toString('utf-8'));
    if (!Array.isArray(parsed)) {
      throw new CredentialError('Credential backup JSON is not an array');
    }
    credentials = parsed as Array<Record<string, unknown>>;
  } catch (err) {
    if (err instanceof CredentialError) throw err;
    throw new CredentialError('Credential backup is not valid JSON after decryption');
  }

  // Step 3: import each credential individually — fail per-item, not all-or-nothing
  const results: CredentialImportResult[] = [];

  for (const cred of credentials) {
    const id   = String(cred['id']   ?? '');
    const name = String(cred['name'] ?? 'unknown');
    const type = String(cred['type'] ?? '');
    const data = (cred['data'] ?? {}) as Record<string, unknown>;

    try {
      await client.createCredential(name, type, data);
      results.push({ id, name, type, success: true });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // Truncate: API schema errors from n8n are safe, but keep length bounded
      const error = raw.length > 300 ? raw.substring(0, 300) + '…' : raw;
      results.push({ id, name, type, success: false, error });
    }
  }

  return results;
}
