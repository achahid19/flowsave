/**
 * @flowsave/core — AES-256-GCM encryption primitive
 *
 * THIS IS THE ONLY FILE THAT MAY CONTAIN CRYPTO LOGIC.
 * Never inline AES-256-GCM operations anywhere else.
 *
 * Security guarantees:
 * - A random 32-byte salt is generated per encryption operation
 * - A random 12-byte IV is generated per encryption operation (GCM recommendation)
 * - Key derivation uses scrypt (cost N=16384, r=8, p=1) — resistant to brute force
 * - The 16-byte GCM auth tag is stored and verified on decrypt (integrity check)
 * - The passphrase never leaves this module and is never stored or logged
 *
 * Wire format (all values concatenated into a single Buffer):
 *   [0..31]   salt      (32 bytes) — scrypt salt
 *   [32..43]  iv        (12 bytes) — AES-GCM IV
 *   [44..59]  authTag   (16 bytes) — GCM authentication tag
 *   [60..]    ciphertext (variable) — encrypted payload
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SALT_LENGTH = 32;
const IV_LENGTH = 12;     // 96-bit IV recommended for AES-GCM
const TAG_LENGTH = 16;    // 128-bit auth tag
const KEY_LENGTH = 32;    // 256-bit key for AES-256

const SCRYPT_N = 16384;   // CPU/memory cost factor (2^14). OWASP recommended minimum.
const SCRYPT_R = 8;       // Block size
const SCRYPT_P = 1;       // Parallelization factor
// Memory usage = 128 * N * r * p = 128 * 16384 * 8 * 1 = 16 MB
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // Explicit 64 MB cap — avoids system-default surprises

const HEADER_LENGTH = SALT_LENGTH + IV_LENGTH + TAG_LENGTH; // 60 bytes

export const MIN_PASSPHRASE_LENGTH = 12;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

// ---------------------------------------------------------------------------
// Passphrase validation
// ---------------------------------------------------------------------------

/**
 * Validate a passphrase against the minimum strength policy.
 *
 * Returns an error message string if the passphrase is too weak,
 * or null if it passes. Exported so CLI prompts can surface inline
 * feedback via inquirer's validate option before encryption is attempted.
 *
 * Rules:
 *   - At least MIN_PASSPHRASE_LENGTH characters (12)
 *   - Must not be all whitespace
 *   - At least one uppercase letter
 *   - At least one lowercase letter
 *   - At least one digit or special character
 */
export function validatePassphrase(passphrase: string): string | null {
  if (passphrase.trim().length === 0) {
    return 'Passphrase must not be blank';
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`;
  }
  if (!/[A-Z]/.test(passphrase)) {
    return 'Passphrase must contain at least one uppercase letter';
  }
  if (!/[a-z]/.test(passphrase)) {
    return 'Passphrase must contain at least one lowercase letter';
  }
  if (!/[0-9!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|`~]/.test(passphrase)) {
    return 'Passphrase must contain at least one digit or special character';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit key from a passphrase and salt using scrypt.
 * This is intentionally slow to resist brute-force attacks.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext using AES-256-GCM with scrypt key derivation.
 *
 * @param plaintext - The data to encrypt
 * @param passphrase - User-provided passphrase (never logged or stored)
 * @returns Encrypted buffer in the wire format described above
 */
export function encrypt(plaintext: Buffer, passphrase: string): Buffer {
  if (plaintext.length === 0) {
    throw new EncryptionError('Cannot encrypt empty plaintext');
  }
  const passphraseError = validatePassphrase(passphrase);
  if (passphraseError) {
    throw new EncryptionError(passphraseError);
  }

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Wipe key from memory as best-effort (Buffer is GC'd but we can zero it)
  key.fill(0);

  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypt a buffer produced by `encrypt()`.
 *
 * @param ciphertext - Buffer in the wire format described above
 * @param passphrase - The passphrase used during encryption
 * @returns Decrypted plaintext buffer
 * @throws EncryptionError if the passphrase is wrong or the data is tampered
 */
export function decrypt(ciphertext: Buffer, passphrase: string): Buffer {
  if (ciphertext.length <= HEADER_LENGTH) {
    throw new EncryptionError('Ciphertext is too short to be a valid encrypted buffer');
  }
  if (passphrase.length === 0) {
    throw new EncryptionError('Passphrase must not be empty');
  }

  const salt = ciphertext.subarray(0, SALT_LENGTH);
  const iv = ciphertext.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = ciphertext.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + TAG_LENGTH
  );
  const encrypted = ciphertext.subarray(HEADER_LENGTH);

  const key = deriveKey(passphrase, salt);

  const decipher = createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  // Wipe key from memory as best-effort
  key.fill(0);

  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    // Do NOT include any details that could aid a brute-force attack
    throw new EncryptionError(
      'Decryption failed — wrong passphrase or corrupted data'
    );
  }
}
