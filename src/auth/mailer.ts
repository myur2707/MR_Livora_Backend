import { createTransport } from 'nodemailer';
import type { loadConfig } from './config.js';
import type { ResidentMailer } from '../resident-access/accounts.js';
export interface ResetMailer {
  send(email: string, link: string): Promise<void>;
}
interface EmailTemplateInput {
  preheader: string;
  eyebrow: string;
  title: string;
  introduction: string;
  actionLabel: string;
  link: string;
  details: readonly string[];
  securityNote: string;
  /** Absolute URL of the brand logo, served by the web app; omitted → text-only header. */
  logoUrl?: string;
}
export interface TransactionalEmail {
  text: string;
  html: string;
}
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export function transactionalEmail(
  input: EmailTemplateInput,
  copyrightYear = new Date().getUTCFullYear(),
): TransactionalEmail {
  const detailsText = input.details.map((detail) => `• ${detail}`).join('\n');
  const detailsHtml = input.details
    .map(
      (detail) =>
        `<tr><td style="padding:0 0 10px;color:#333333;font-size:14px;line-height:1.55"><span style="color:#c91f26;font-weight:700">✓</span>&nbsp;&nbsp;${escapeHtml(detail)}</td></tr>`,
    )
    .join('');
  const safeLink = escapeHtml(input.link);
  // A hosted image (not an attachment) keeps messages small; alt text covers blocked images.
  const logo = input.logoUrl
    ? `<td style="padding-right:14px;vertical-align:middle"><img src="${escapeHtml(input.logoUrl)}" width="56" height="56" alt="Mr. Livora" style="display:block;border:0;border-radius:50%;background:#ffffff"></td>`
    : '';
  const text = `${input.title}\n\n${input.introduction}\n\n${input.actionLabel}:\n${input.link}\n\n${detailsText}\n\nSecurity note: ${input.securityNote}\n\nMr. Livora — Live in a Better Aura\n© ${copyrightYear} Mr. Livora. All rights reserved.`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title></head>
<body style="margin:0;padding:0;background:#f5f3f3;color:#171717;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f3f3"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #ded8d8;border-radius:18px;overflow:hidden;box-shadow:0 14px 38px rgba(20,10,10,.10)">
<tr><td style="height:6px;background:#c91f26;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:24px 34px 20px;background:#111111">
<table role="presentation" cellspacing="0" cellpadding="0"><tr>${logo}<td style="vertical-align:middle">
<div style="color:#ffffff;font-family:Georgia,'Times New Roman',serif;font-size:25px;font-weight:700;letter-spacing:.2px">Mr. <span style="color:#ef3139">Livora</span></div>
<div style="margin-top:6px;color:#d8d2d2;font-size:12px;letter-spacing:1.6px;text-transform:uppercase">Live in a Better Aura</div>
</td></tr></table>
</td></tr>
<tr><td style="padding:34px">
<div style="color:#c91f26;font-size:11px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase">${escapeHtml(input.eyebrow)}</div>
<h1 style="margin:10px 0 14px;color:#171717;font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.2">${escapeHtml(input.title)}</h1>
<p style="margin:0 0 24px;color:#555555;font-size:15px;line-height:1.65">${escapeHtml(input.introduction)}</p>
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:9px;background:#c91f26"><a href="${safeLink}" style="display:inline-block;padding:14px 22px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">${escapeHtml(input.actionLabel)}</a></td></tr></table>
<p style="margin:14px 0 26px;color:#777777;font-size:12px;line-height:1.5">If the button does not work, copy and paste this address into your browser:<br><a href="${safeLink}" style="color:#a9161c;word-break:break-all">${safeLink}</a></p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #ebe6e6;padding-top:20px">${detailsHtml}</table>
<div style="margin-top:14px;padding:14px 16px;border-left:4px solid #c91f26;background:#fff3f3;color:#4d4040;font-size:13px;line-height:1.55"><strong style="color:#171717">Security note:</strong> ${escapeHtml(input.securityNote)}</div>
</td></tr>
<tr><td style="padding:20px 34px;background:#111111;color:#bdb7b7;text-align:center;font-size:11px;line-height:1.6">This is an automated service message from Mr. Livora.<br>© ${copyrightYear} Mr. Livora. All rights reserved.</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}
export function smtpMailer(config: ReturnType<typeof loadConfig>): ResetMailer & {
  sendInvitation(email: string, link: string, societyName: string): Promise<void>;
} & ResidentMailer {
  const logoUrl = new URL('/assets/brand/logo.png', config.APP_ORIGIN).href;
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
      const content = transactionalEmail({
        logoUrl,
        preheader: 'Verify your email to finish creating your Mr. Livora account.',
        eyebrow: 'Email verification',
        title: 'Verify your email address',
        introduction:
          'Complete your account setup by confirming that this email address belongs to you.',
        actionLabel: 'Verify email address',
        link,
        details: [
          'This secure, single-use link expires in 30 minutes.',
          'Verification creates your login; community access still requires committee approval.',
        ],
        securityNote: 'Mr. Livora will never ask you to send your password by email.',
      });
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Verify your Mr. Livora email',
        ...content,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
    async existingAccount(email, link) {
      const content = transactionalEmail({
        logoUrl,
        preheader: 'Your email is already linked to a Mr. Livora account.',
        eyebrow: 'Existing account',
        title: 'Continue with your existing account',
        introduction:
          'An account already exists for this email address. Sign in to request access to another community.',
        actionLabel: 'Sign in to Mr. Livora',
        link,
        details: [
          'Your password has not been changed.',
          'No new community access has been granted.',
        ],
        securityNote: 'If you did not attempt to register, you can safely ignore this message.',
      });
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Your Mr. Livora registration instructions',
        ...content,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
    async invitation(email, link, society) {
      const content = transactionalEmail({
        logoUrl,
        preheader: `${society} invited you to join its resident workspace.`,
        eyebrow: 'Resident invitation',
        title: `You are invited to ${society}`,
        introduction:
          'The community committee has verified a resident record for you. Accept the invitation to connect your account.',
        actionLabel: 'Accept resident invitation',
        link,
        details: [
          'This secure, single-use invitation expires in 72 hours.',
          'Existing users must sign in with the invited email address.',
          'This invitation grants the Resident role only.',
        ],
        securityNote: 'Only accept this invitation if you recognize the community named above.',
      });
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Your Mr. Livora resident invitation',
        ...content,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
    async sendInvitation(email, link, societyName) {
      const content = transactionalEmail({
        logoUrl,
        preheader: `${societyName} invited you to help complete its community setup.`,
        eyebrow: 'Committee invitation',
        title: `Help set up ${societyName}`,
        introduction:
          'You have been invited to review and complete this community workspace before activation.',
        actionLabel: 'Review committee invitation',
        link,
        details: [
          'This secure, single-use invitation expires in 72 hours.',
          'Existing users must sign in with the invited email address.',
          'You will review the setup before the community is activated.',
        ],
        securityNote: 'Only continue if you expected this committee invitation.',
      });
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Your Mr. Livora committee invitation',
        ...content,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
    async send(email, link) {
      const content = transactionalEmail({
        logoUrl,
        preheader: 'Use this secure link to reset your Mr. Livora password.',
        eyebrow: 'Password assistance',
        title: 'Reset your password',
        introduction: 'We received a request to create a new password for your Mr. Livora account.',
        actionLabel: 'Reset password',
        link,
        details: [
          'This secure, single-use link expires in 30 minutes.',
          'After the reset, existing sessions are revoked to protect your account.',
        ],
        securityNote: 'If you did not request a password reset, ignore this email.',
      });
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: 'Reset your Mr. Livora password',
        ...content,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
  };
}
