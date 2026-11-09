import { scryptSync, randomBytes, timingSafeEqual, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [, s, h] = stored.split('$');
  const calc = scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
export function passwordPolicyError(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw))
    return 'Password needs upper, lower, digit and special character.';
  return null;
}
export function signToken(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verifyToken(token: string, secret: string): any | null {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expect = createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = ((val << 8) | b) & 0xffff; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string): Buffer {
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of s.toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; val = ((val << 5) | i) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totp(secret: string, atMs: number): string {      // RFC 6238, SHA-1, 30s, 6 digits
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = createHmac('sha1', unbase32(secret)).update(b).digest(), o = h[19] & 15;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}
export function verifyTotp(secret: string | null, code: unknown, atMs: number): boolean {
  if (!secret) return false;
  return [-1, 0, 1].some((d) => totp(secret, atMs + d * 30000) === String(code ?? ''));
}

// Encrypt-at-rest for secrets (e.g. MFA seeds): AES-256-GCM, key derived from the server secret.
const keyCache = new Map<string, Buffer>();
const dataKey = (secret: string) => { let k = keyCache.get(secret); if (!k) { k = scryptSync(secret, 'sems-data-key', 32); keyCache.set(secret, k); } return k; };
export function seal(plain: string, secret: string): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', dataKey(secret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
export function unseal(sealed: string, secret: string): string | null {     // null on tamper / wrong key
  try {
    const [v, iv, tag, ct] = sealed.split('.'); if (v !== 'v1') return null;
    const d = createDecipheriv('aes-256-gcm', dataKey(secret), Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}
