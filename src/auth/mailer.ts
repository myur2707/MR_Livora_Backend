import { createTransport } from 'nodemailer';
import type { loadConfig } from './config.js';
import type { ResidentMailer } from '../resident-access/accounts.js';
export interface ResetMailer {
  send(email: string, link: string): Promise<void>;
}
export function smtpMailer(config: ReturnType<typeof loadConfig>): ResetMailer & {
  sendInvitation(email: string, link: string, societyName: string): Promise<void>;
} & ResidentMailer {
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
    async verification(email, link) {
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Verify your MR Livora email',
        text:
          'Verify your email within 30 minutes:\n\n' +
          link +
          '\n\nThis creates a login only. Society access requires committee approval.',
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
    async existingAccount(email, link) {
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Your MR Livora registration instructions',
        text:
          'Sign in with your existing account to request another society membership:\n\n' +
          link +
          '\n\nNo password or society access was changed.',
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
    async invitation(email, link, society) {
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Your MR Livora resident invitation',
        text:
          'The committee of ' +
          society +
          ' has verified your resident record and invited you. Open this single-use link within 72 hours:\n\n' +
          link +
          '\n\nExisting accounts must sign in with the invited email. New accounts can create a password. This invitation grants the Resident role only.',
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
    async sendInvitation(email, link, societyName) {
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Your MR Livora committee invitation',
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
        subject: 'Reset your MR Livora password',
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
