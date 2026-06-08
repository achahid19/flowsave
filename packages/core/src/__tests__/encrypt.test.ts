import { describe, it, expect } from 'vitest';
import { decrypt, encrypt, EncryptionError } from '../encrypt';

describe('encrypt / decrypt', () => {
  const passphrase = 'correct-horse-battery-staple';
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

  it('throws EncryptionError for empty passphrase on encrypt', () => {
    expect(() => encrypt(plaintext, '')).toThrow(EncryptionError);
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
