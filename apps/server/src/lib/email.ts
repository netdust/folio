import nodemailer from 'nodemailer';
import { env } from '../env.ts';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;
  if (!env.SMTP_HOST) return null; // dev mode - log only
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
  });
  return transporter;
}

function magicLinkUrl(token: string): string {
  return `${env.PUBLIC_URL}/auth/magic-link/consume?token=${token}`;
}

// Shared send (or dev-console fallback when no SMTP is configured). Returns
// nothing — in dev the link is logged so it can be copy-pasted.
async function deliver(email: string, subject: string, text: string, devLabel: string): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.log(`\n[folio] ${devLabel} for ${email}:\n  ${magicLinkUrl(extractToken(text))}\n`);
    return;
  }
  await t.sendMail({ to: email, from: env.SMTP_FROM, subject, text });
}

// The dev-console fallback re-derives the URL from the token; pull it back out of
// the message body so deliver() stays message-agnostic.
function extractToken(text: string): string {
  const m = text.match(/consume\?token=([^\s]+)/);
  return m ? m[1]! : '';
}

export async function sendMagicLink(email: string, token: string): Promise<void> {
  const url = magicLinkUrl(token);
  await deliver(
    email,
    'Sign in to Folio',
    `Click to sign in to Folio: ${url}\n\nThis link expires in 15 minutes.`,
    'Magic link',
  );
}

/**
 * Admin-initiated invite. Same magic-link mechanism as sign-in (the consume path
 * upserts the user as a plain member), but invite-worded so the recipient knows
 * they're being added to the team rather than signing in to an existing account.
 */
export async function sendInvite(email: string, token: string, inviterName: string): Promise<void> {
  const url = magicLinkUrl(token);
  await deliver(
    email,
    "You've been invited to Folio",
    `${inviterName} invited you to join their Folio workspace.\n\n` +
      `Click to accept and sign in: ${url}\n\nThis link expires in 15 minutes.`,
    'Invite link',
  );
}
