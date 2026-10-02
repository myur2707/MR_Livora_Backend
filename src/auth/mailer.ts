import { createTransport } from 'nodemailer';
import type { loadConfig } from './config.js';
export interface ResetMailer {
  send(email: string, link: string): Promise<void>;
}
export function smtpMailer(config: ReturnType<typeof loadConfig>): ResetMailer {
  const transport = createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    requireTLS: true,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    logger: false,
    debug: false,
  });
  return {
    async send(email, link) {
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Reset your SocietyEase password',
        text:
          'Use this single-use link within 30 minutes to reset your password:\n\n' +
          link +
          '\n\nIf you did not request this, you can ignore this message.',
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
  };
}
