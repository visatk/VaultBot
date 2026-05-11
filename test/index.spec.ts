// ─── test/index.spec.ts ───────────────────────────────────────
// VaultBot integration tests using cloudflare:test (Vitest + Workers pool).
// Covers: HTTP routing, webhook processing, crypto round-trips.

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  SELF,
} from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src';

// ── HTTP endpoint tests ───────────────────────────────────────

describe('VaultBot HTTP endpoints', () => {
  describe('GET /health', () => {
    it('returns 200 with status:ok (unit style)', async () => {
      const req = new Request('http://bot.example.com/health');
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      const json = await res.json() as { status: string };
      expect(json.status).toBe('ok');
    });

    it('returns 200 with status:ok (integration style)', async () => {
      const res = await SELF.fetch('http://bot.example.com/health');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /webhook', () => {
    it('returns 200 OK for valid JSON update', async () => {
      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 99999, first_name: 'Test', is_bot: false },
          chat: { id: 99999, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: '/start',
        },
      };
      const req = new Request('http://bot.example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      // Webhook must ALWAYS return 200 quickly
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('OK');
    });

    it('returns 400 for malformed JSON', async () => {
      const req = new Request('http://bot.example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(400);
    });
  });

  describe('Unknown routes', () => {
    it('returns 404 for GET /unknown', async () => {
      const req = new Request('http://bot.example.com/unknown');
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(404);
    });
  });
});

// ── Crypto round-trip tests ────────────────────────────────────

describe('Crypto utilities', () => {
  // A valid 64-char hex key (32 bytes)
  const TEST_KEY = 'a'.repeat(64);

  beforeAll(async () => {
    // Ensure we're in a Workers environment with crypto.subtle
    expect(globalThis.crypto?.subtle).toBeDefined();
  });

  it('encrypt → decrypt round-trips correctly', async () => {
    const { encrypt, decrypt } = await import('../src/crypto');
    const plaintext = 'super-secret-password-123!';
    const { cipherB64, ivHex } = await encrypt(plaintext, TEST_KEY);

    expect(cipherB64).toBeTruthy();
    expect(ivHex).toHaveLength(24); // 12 bytes = 24 hex chars

    const decrypted = await decrypt(cipherB64, ivHex, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypt produces different ciphertext each call (random IV)', async () => {
    const { encrypt } = await import('../src/crypto');
    const plaintext = 'test';
    const r1 = await encrypt(plaintext, TEST_KEY);
    const r2 = await encrypt(plaintext, TEST_KEY);
    expect(r1.cipherB64).not.toBe(r2.cipherB64);
    expect(r1.ivHex).not.toBe(r2.ivHex);
  });

  it('decrypt throws on wrong key', async () => {
    const { encrypt, decrypt } = await import('../src/crypto');
    const { cipherB64, ivHex } = await encrypt('secret', TEST_KEY);
    const wrongKey = 'b'.repeat(64);
    await expect(decrypt(cipherB64, ivHex, wrongKey)).rejects.toThrow();
  });

  it('decrypt throws on tampered ciphertext', async () => {
    const { encrypt, decrypt } = await import('../src/crypto');
    const { cipherB64, ivHex } = await encrypt('secret', TEST_KEY);
    const tampered = cipherB64.slice(0, -4) + 'AAAA';
    await expect(decrypt(tampered, ivHex, TEST_KEY)).rejects.toThrow();
  });

  it('generatePassword produces correct length', async () => {
    const { generatePassword } = await import('../src/crypto');
    const pw = generatePassword({ length: 24 });
    expect(pw).toHaveLength(24);
  });

  it('generatePassword excludes specified characters', async () => {
    const { generatePassword } = await import('../src/crypto');
    const excluded = 'lI1O0';
    const pw = generatePassword({ length: 100, exclude: excluded });
    for (const ch of excluded) {
      expect(pw).not.toContain(ch);
    }
  });

  it('passwordStrength scores correctly', async () => {
    const { passwordStrength } = await import('../src/crypto');
    expect(passwordStrength('abc').score).toBe(0); // very weak
    expect(passwordStrength('Abcdefghij1!').score).toBeGreaterThanOrEqual(3);
    expect(passwordStrength('MyStr0ng&Pass!xyz').score).toBe(4); // very strong
  });

  it('isValidBase32 validates correctly', async () => {
    const { isValidBase32 } = await import('../src/crypto');
    expect(isValidBase32('JBSWY3DPEHPK3PXP')).toBe(true);
    expect(isValidBase32('JBSWY3DP EHPK3PXP')).toBe(true); // spaces OK
    expect(isValidBase32('INVALID8901')).toBe(false); // 8 and 9 not in Base32
  });

  it('parseOtpauthUri parses valid otpauth URI', async () => {
    const { parseOtpauthUri } = await import('../src/crypto');
    const uri = 'otpauth://totp/Example%3AAlice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example';
    const parsed = parseOtpauthUri(uri);
    expect(parsed).not.toBeNull();
    expect(parsed!.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(parsed!.issuer).toBe('Example');
    expect(parsed!.algorithm).toBe('SHA1');
    expect(parsed!.digits).toBe(6);
    expect(parsed!.period).toBe(30);
  });

  it('parseOtpauthUri returns null for non-otpauth URIs', async () => {
    const { parseOtpauthUri } = await import('../src/crypto');
    expect(parseOtpauthUri('https://example.com')).toBeNull();
    expect(parseOtpauthUri('not a uri')).toBeNull();
  });

  it('generateTOTP produces correct-length code', async () => {
    const { generateTOTP } = await import('../src/crypto');
    const { code, remaining, nextCode } = await generateTOTP('JBSWY3DPEHPK3PXP');
    expect(code).toHaveLength(6);
    expect(nextCode).toHaveLength(6);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(30);
  });
});
