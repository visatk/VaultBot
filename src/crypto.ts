/**
 * Crypto helpers using Web Crypto API (available in all Workers runtimes).
 * All secrets are encrypted with AES-256-GCM.
 * Master password verification uses PBKDF2-SHA256 (310 000 iterations).
 */

// ── PBKDF2 ─────────────────────────────────────────────────────────────────

export async function hashMasterPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = salt
    ? hexToBytes(salt)
    : crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: 310_000 },
    keyMaterial,
    256,
  );

  return {
    hash: bytesToHex(new Uint8Array(bits)),
    salt: bytesToHex(saltBytes),
  };
}

export async function verifyMasterPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const { hash: derived } = await hashMasterPassword(password, salt);
  // Timing-safe comparison via SubtleCrypto sign trick
  const a = hexToBytes(derived);
  const b = hexToBytes(hash);
  if (a.length !== b.length) return false;
  const key = await crypto.subtle.importKey('raw', a, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return crypto.subtle.verify('HMAC', key, b, a);
}

// ── AES-256-GCM ────────────────────────────────────────────────────────────

async function deriveAESKey(hexKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    hexToBytes(hexKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(plaintext: string, hexKey: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await deriveAESKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: bytesToHex(new Uint8Array(enc)),
    iv: bytesToHex(iv),
  };
}

export async function decrypt(ciphertext: string, iv: string, hexKey: string): Promise<string> {
  const key = await deriveAESKey(hexKey);
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(iv) },
    key,
    hexToBytes(ciphertext),
  );
  return new TextDecoder().decode(dec);
}

// ── Utility ─────────────────────────────────────────────────────────────────

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return arr;
}

export function generatePassword(length = 20): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}|;:,.<>?';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}
