import crypto from 'node:crypto';

/** Constant-time string equality (length mismatch returns false, never throws). */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still touch both buffers so length leaks are harder to exploit via early return timing alone
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
