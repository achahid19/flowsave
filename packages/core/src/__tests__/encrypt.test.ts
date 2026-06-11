import { describe, it, expect } from 'vitest';
import { decrypt, encrypt, EncryptionError, MIN_PASSPHRASE_LENGTH, validatePassphrase } from '../encrypt';

describe('encrypt / decrypt', () => {
  const passphrase = 'Correct-Horse-Battery-1';
  const plaintext = Buffer.from(JSON.stringify({ secret: 'my-api-key' }));

  it('round-trips plaintext correctly', () => {
    const ciphertext = encrypt(plaintext, passphrase);
    const result = decrypt(ciphertext, passphrase);
    expect(result.toString()).toBe(plaintext.toString());
  });

  it('produces different ciphertext on each call (random IV + salt)', () => {
    const a = encrypt(plaintext, passphrase);
    const b = encrypt(plaintext, passphrase);
    expect(a.toString('hex')).not.toBe(b.toString('hex'));
  });

  it('encrypted output is longer than plaintext by the header size', () => {
    const ciphertext = encrypt(plaintext, passphrase);
    // Header = 32 (salt) + 12 (iv) + 16 (authTag) = 60 bytes
    expect(ciphertext.length).toBe(plaintext.length + 60);
  });

  it('throws EncryptionError with wrong passphrase', () => {
    const ciphertext = encrypt(plaintext, passphrase);
    expect(() => decrypt(ciphertext, 'wrong-passphrase')).toThrow(EncryptionError);
  });

  it('throws EncryptionError with tampered ciphertext', () => {
    const ciphertext = encrypt(plaintext, passphrase);
    // Flip a byte in the payload area
    ciphertext[ciphertext.length - 1] ^= 0xff;
    expect(() => decrypt(ciphertext, passphrase)).toThrow(EncryptionError);
  });

  it('throws EncryptionError for empty plaintext', () => {
    expect(() => encrypt(Buffer.alloc(0), passphrase)).toThrow(EncryptionError);
  });

  it('throws EncryptionError for weak passphrase on encrypt', () => {
    expect(() => encrypt(plaintext, 'weak')).toThrow(EncryptionError);
  });

  it('throws EncryptionError for empty passphrase on decrypt', () => {
    const ciphertext = encrypt(plaintext, passphrase);
    expect(() => decrypt(ciphertext, '')).toThrow(EncryptionError);
  });

  it('throws EncryptionError for truncated ciphertext', () => {
    // Anything <= 60 bytes is too short
    const tooShort = Buffer.alloc(60);
    expect(() => decrypt(tooShort, passphrase)).toThrow(EncryptionError);
  });

  it('handles binary plaintext (not just UTF-8 strings)', () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    const ciphertext = encrypt(binary, passphrase);
    const result = decrypt(ciphertext, passphrase);
    expect(result.toString('hex')).toBe(binary.toString('hex'));
  });
});

describe('validatePassphrase', () => {
  it('returns null for a valid passphrase', () => {
    expect(validatePassphrase('Correct-Horse-Battery-1')).toBeNull();
  });

  it(`rejects passphrases shorter than ${MIN_PASSPHRASE_LENGTH} characters`, () => {
    expect(validatePassphrase('Short1!')).not.toBeNull();
  });

  it('rejects all-whitespace input', () => {
    expect(validatePassphrase('            ')).not.toBeNull();
  });

  it('rejects passphrases with no uppercase letter', () => {
    expect(validatePassphrase('no-uppercase-here-1!')).not.toBeNull();
  });

  it('rejects passphrases with no lowercase letter', () => {
    expect(validatePassphrase('NO-LOWERCASE-HERE-1!')).not.toBeNull();
  });

  it('rejects passphrases with no digit or special character', () => {
    expect(validatePassphrase('NoDigitOrSpecialHere')).not.toBeNull();
  });

  it('accepts a passphrase with a digit instead of a special character', () => {
    expect(validatePassphrase('CorrectHorseBattery1')).toBeNull();
  });

  it('accepts a passphrase with a special character instead of a digit', () => {
    expect(validatePassphrase('Correct-Horse-Battery!')).toBeNull();
  });

  it('returns the specific rule that failed', () => {
    expect(validatePassphrase('short')).toMatch(/at least 12/);
    expect(validatePassphrase('no-uppercase-here-1!')).toMatch(/uppercase/);
    expect(validatePassphrase('NO-LOWERCASE-1!')).toMatch(/lowercase/);
    expect(validatePassphrase('NoDigitOrSpecialHere')).toMatch(/digit or special/);
  });
});
