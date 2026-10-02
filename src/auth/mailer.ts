import { createTransport } from 'nodemailer';
import type { loadConfig } from './config.js';
export interface ResetMailer {
  send(email: string, link: string): Promise<void>;
}
export function smtpMailer(config: ReturnType<typeof loadConfig>): ResetMailer & {
  sendInvitation(email: string, link: string, societyName: string): Promise<void>;
} {
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
    async sendInvitation(email, link, societyName) {
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Your SocietyEase committee invitation',
        text:
          'You are invited to help set up ' +
          societyName +
          '. Open this single-use link within 72 hours:\n\n' +
          link +
          '\n\nExisting accounts must sign in with the invited email. You will review the setup before activation.',
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
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
