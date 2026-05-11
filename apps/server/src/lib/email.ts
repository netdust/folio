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

export async function sendMagicLink(email: string, token: string): Promise<void> {
  const url = `${env.PUBLIC_URL}/auth/magic/verify?token=${token}`;
  const subject = 'Sign in to Folio';
  const text = `Click to sign in to Folio: ${url}\n\nThis link expires in 15 minutes.`;

  const t = getTransporter();
  if (!t) {
    // Dev mode - log the link to the server console so you can copy-paste it.
    console.log(`\n[folio] Magic link for ${email}:\n  ${url}\n`);
    return;
  }
  await t.sendMail({
    to: email,
    from: env.SMTP_FROM,
    subject,
    text,
  });
}
