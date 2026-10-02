import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';

export const passwordOptions = {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;
export const newToken = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (token: string): Buffer => createHash('sha256').update(token).digest();
export const keyedHash = (secret: string, value: string): Buffer =>
  createHmac('sha256', secret).update(value).digest();
export const csrfToken = (secret: string, token: string): string =>
  keyedHash(secret, 'csrf:' + token).toString('base64url');
export function equalToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export const hashPassword = (password: string): Promise<string> => hash(password, passwordOptions);
export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    return await verify(encoded, password);
  } catch {
    return false;
  }
}
