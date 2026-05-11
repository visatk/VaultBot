const keyCache = new Map<string, CryptoKey>();

async function getMasterKey(hexKey: string): Promise<CryptoKey> {
  const cacheKey = hexKey.slice(0, 8); // use prefix as cache identifier (safe — not a secret)
  let key = keyCache.get(cacheKey);
  if (key) return key;

  const raw = hexToBytes(hexKey.slice(0, 64)); // exactly 32 bytes → AES-256
  if (raw.length !== 32) {
    throw new Error('[Crypto] ENCRYPTION_KEY must be at least 64 hex chars (32 bytes)');
  }

  key = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    false,       // non-extractable
    ['encrypt', 'decrypt'],
  );
  keyCache.set(cacheKey, key);
  return key;
}

// ── AES-256-GCM Encryption ────────────────────────────────────

/**
 * Encrypt plaintext → { cipherB64, ivHex }
 * Uses a fresh 96-bit (12-byte) random IV per call — never reuse IVs.
 */
export async function encrypt(
  plaintext: string,
  hexKey: string,
): Promise<{ cipherB64: string; ivHex: string }> {
  const key  = await getMasterKey(hexKey);
  const iv   = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
  const data = new TextEncoder().encode(plaintext);

  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

  return {
    cipherB64: uint8ToBase64(new Uint8Array(cipherBuf)),
    ivHex:     bytesToHex(iv),
  };
}

/**
 * Decrypt cipherB64 + ivHex → plaintext
 * Throws on authentication failure (tampered ciphertext / wrong key).
 */
export async function decrypt(
  cipherB64: string,
  ivHex: string,
  hexKey: string,
): Promise<string> {
  const key    = await getMasterKey(hexKey);
  const iv     = hexToBytes(ivHex);
  const cipher = base64ToUint8(cipherB64);

  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

// ── TOTP (RFC 6238 / HOTP RFC 4226) ──────────────────────────

/**
 * Generate a TOTP code for a Base32 TOTP secret.
 * Uses BigInt for the 64-bit counter to match RFC 4226 §5.
 */
export async function generateTOTP(
  base32Secret: string,
  period   = 30,
  digits   = 6,
  algo:      'SHA1' | 'SHA256' | 'SHA512' = 'SHA1',
  at?:       number,
): Promise<{ code: string; remaining: number; nextCode: string }> {
  const now       = at ?? Math.floor(Date.now() / 1000);
  const counter   = BigInt(Math.floor(now / period));
  const remaining = period - (now % period);

  const keyBytes = base32Decode(base32Secret.replace(/\s/g, '').toUpperCase());

  const hashName = algo === 'SHA1' ? 'SHA-1' : algo === 'SHA256' ? 'SHA-256' : 'SHA-512';
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: hashName },
    false,
    ['sign'],
  );

  const code     = await computeHOTP(cryptoKey, counter, digits);
  const nextCode = await computeHOTP(cryptoKey, counter + 1n, digits);

  return { code, remaining, nextCode };
}

/** Internal HOTP computation for a given 64-bit counter value */
async function computeHOTP(
  cryptoKey: CryptoKey,
  counter:   bigint,
  digits:    number,
): Promise<string> {
  // Big-endian 8-byte counter buffer
  const counterBuf = new ArrayBuffer(8);
  const view       = new DataView(counterBuf);
  view.setUint32(0, Number(counter >> 32n) >>> 0, false); // high word
  view.setUint32(4, Number(counter & 0xFFFFFFFFn) >>> 0, false); // low word

  const hmac   = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counterBuf));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const otp    =
    (((hmac[offset]     & 0x7f) << 24) |
      (hmac[offset + 1] << 16)         |
      (hmac[offset + 2] << 8)          |
       hmac[offset + 3])               %
    Math.pow(10, digits);

  return otp.toString().padStart(digits, '0');
}

// ── Password generator ────────────────────────────────────────

export interface PasswordOptions {
  length?:   number;
  upper?:    boolean;
  numbers?:  boolean;
  symbols?:  boolean;
  exclude?:  string; // characters to exclude (e.g. 'lI1O0')
}

/**
 * Generate a cryptographically secure random password.
 * Uses rejection sampling to avoid modulo bias.
 */
export function generatePassword(opts: PasswordOptions = {}): string {
  const {
    length  = 20,
    upper   = true,
    numbers = true,
    symbols = true,
    exclude = '',
  } = opts;

  const lower      = 'abcdefghijklmnopqrstuvwxyz';
  const upperChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numChars   = '0123456789';
  const symChars   = '!@#$%^&*()-_=+[]{}|;:,.<>?';

  let charset = lower;
  if (upper)   charset += upperChars;
  if (numbers) charset += numChars;
  if (symbols) charset += symChars;
  if (exclude) charset = charset.split('').filter((c) => !exclude.includes(c)).join('');

  if (charset.length === 0) throw new Error('[Crypto] empty charset — check exclude options');

  // Rejection sampling to eliminate modulo bias
  const result: string[] = [];
  while (result.length < length) {
    const rand = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of rand) {
      if (result.length >= length) break;
      // Only accept bytes that fall in a range evenly divisible by charset.length
      const limit = Math.floor(256 / charset.length) * charset.length;
      if (byte < limit) result.push(charset[byte % charset.length]);
    }
  }
  return result.join('');
}

// ── Passphrase generator ──────────────────────────────────────

const WORDLIST = [
  'apple', 'brave', 'cloud', 'delta', 'eagle', 'flame', 'grace', 'honey',
  'ivory', 'jewel', 'karma', 'lemon', 'maple', 'noble', 'ocean', 'pearl',
  'queen', 'river', 'storm', 'tiger', 'ultra', 'violet', 'waltz', 'xenon',
  'yacht', 'zebra', 'amber', 'blast', 'crisp', 'dusk',
];

export function generatePassphrase(wordCount = 4): string {
  const arr = crypto.getRandomValues(new Uint8Array(wordCount));
  return Array.from(arr, (b) => WORDLIST[b % WORDLIST.length]).join('-');
}

// ── Validation ────────────────────────────────────────────────

/** Validate a Base32 TOTP secret */
export function isValidBase32(s: string): boolean {
  return /^[A-Z2-7]+=*$/i.test(s.replace(/\s/g, ''));
}

/** Calculate password strength score 0–4 */
export function passwordStrength(pw: string): { score: number; label: string } {
  let score = 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  score = Math.min(4, score);
  const labels = ['Very Weak', 'Weak', 'Fair', 'Strong', 'Very Strong'];
  return { score, label: labels[score] };
}

// ── Parse otpauth:// URI ──────────────────────────────────────

export function parseOtpauthUri(uri: string): {
  label: string; issuer: string; secret: string;
  algorithm: string; digits: number; period: number;
} | null {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'otpauth:') return null;
    const params        = u.searchParams;
    const labelRaw      = decodeURIComponent(u.pathname.slice(1));
    const [issuerFromLabel, accountName] = labelRaw.includes(':')
      ? labelRaw.split(':').map((s) => s.trim())
      : ['', labelRaw.trim()];

    const secret = (params.get('secret') || '').toUpperCase().replace(/\s/g, '');
    if (!secret || !isValidBase32(secret)) return null;

    return {
      label:     accountName || labelRaw,
      issuer:    params.get('issuer') || issuerFromLabel || '',
      secret,
      algorithm: (params.get('algorithm') || 'SHA1').toUpperCase(),
      digits:    Math.max(6, Math.min(8, parseInt(params.get('digits') || '6', 10))),
      period:    Math.max(15, Math.min(60, parseInt(params.get('period') || '30', 10))),
    };
  } catch {
    return null;
  }
}

// ── Secure random token (for webhook secret, etc.) ────────────

export function generateSecureToken(bytes = 32): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ── Byte / encoding helpers ───────────────────────────────────

const B32CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(encoded: string): Uint8Array {
  let bits  = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of encoded.replace(/=+$/, '')) {
    const idx = B32CHARS.indexOf(char);
    if (idx === -1) continue; // ignore invalid chars
    value  = (value << 5) | idx;
    bits  += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('[Crypto] hex string must have even length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Safe base64 encoding for large buffers.
 * Avoids call-stack overflow from spread operator on large arrays.
 */
function uint8ToBase64(buf: Uint8Array): string {
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
