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

async function sendEmail(_input: { subject: string; body: string }): Promise<void> {
  // SMTP via nodemailer would go here. Phase 1 leaves this as a no-op when SMTP_* not set.
  if (!config.SMTP_HOST || !config.ALERT_EMAIL_TO) return;
  // Minimal placeholder — actual nodemailer call to be wired with the dependency.
  logger.info({ to: config.ALERT_EMAIL_TO, subject: _input.subject }, 'alert.email.placeholder');
}
