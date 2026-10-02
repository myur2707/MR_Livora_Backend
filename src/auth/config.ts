import { z } from 'zod';

const configuration = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: z.url(),
  AUTH_SECRET: z.string().regex(/^[a-f0-9]{64,}$/),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  SMTP_FROM: z.email(),
});
export interface AuthConfig {
  origin: string;
  secret: string;
  secure: boolean;
  cookieName: string;
  idleMs: number;
  absoluteMs: number;
  resetMs: number;
}
export function loadConfig(env: NodeJS.ProcessEnv) {
  const parsed = configuration.safeParse(env);
  if (!parsed.success) throw new Error('Invalid server configuration. See .env.example.');
  const values = parsed.data;
  const origin = new URL(values.APP_ORIGIN);
  const secure = values.NODE_ENV === 'production';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    origin.origin !== values.APP_ORIGIN ||
    origin.username ||
    origin.password ||
    !['http:', 'https:'].includes(origin.protocol) ||
    (secure ? origin.protocol !== 'https:' : !loopback)
  ) {
    throw new Error(
      'APP_ORIGIN requires an exact HTTPS production origin or loopback development origin.',
    );
  }
  return {
    ...values,
    auth: {
      origin: origin.origin,
      secret: values.AUTH_SECRET,
      secure,
      cookieName: secure ? '__Host-livora_session' : 'livora_session',
      idleMs: 30 * 60_000,
      absoluteMs: 12 * 60 * 60_000,
      resetMs: 30 * 60_000,
    } satisfies AuthConfig,
  };
}
