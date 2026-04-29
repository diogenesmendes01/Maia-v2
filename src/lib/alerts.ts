import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

export async function sendAlert(input: { subject: string; body: string }): Promise<void> {
  const channels = config.ALERT_CHANNELS;
  const tasks: Array<Promise<unknown>> = [];
  if (channels.includes('telegram')) tasks.push(sendTelegram(input));
  if (channels.includes('email')) tasks.push(sendEmail(input));
  await Promise.allSettled(tasks);
}

async function sendTelegram({ subject, body }: { subject: string; body: string }): Promise<void> {
  const token = config.TELEGRAM_BOT_TOKEN;
  const chat_id = config.TELEGRAM_CHAT_ID;
  if (!token || !chat_id) return;
  const text = `[MAIA ALERT] ${subject}\n\n${body}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id, text }),
    });
    if (!res.ok) logger.warn({ status: res.status }, 'alert.telegram_failed');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'alert.telegram_failed');
  }
}

async function sendEmail({ subject, body }: { subject: string; body: string }): Promise<void> {
  if (!config.SMTP_HOST || !config.ALERT_EMAIL_TO) return;
  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT ?? 587,
      secure: (config.SMTP_PORT ?? 587) === 465,
      auth:
        config.SMTP_USER && config.SMTP_PASS
          ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
          : undefined,
    });
    const from = config.SMTP_USER ?? `maia@${config.SMTP_HOST}`;
    await transporter.sendMail({
      from,
      to: config.ALERT_EMAIL_TO,
      subject: `[MAIA ALERT] ${subject}`,
      text: body,
    });
    logger.info({ to: config.ALERT_EMAIL_TO, subject }, 'alert.email.sent');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'alert.email_failed');
  }
}
