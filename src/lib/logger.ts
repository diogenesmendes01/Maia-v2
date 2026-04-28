import pino from 'pino';
import { config } from '@/config/env.js';

const REDACT_PATHS = [
  '*.ANTHROPIC_API_KEY',
  '*.OPENAI_API_KEY',
  '*.VOYAGE_API_KEY',
  '*.TELEGRAM_BOT_TOKEN',
  '*.SMTP_PASS',
  '*.POSTGRES_PASSWORD',
  '*.password',
  '*.token',
  '*.api_key',
  '*.apiKey',
  'authorization',
  'cookie',
  'config.ANTHROPIC_API_KEY',
  'config.OPENAI_API_KEY',
  'config.VOYAGE_API_KEY',
  'config.SMTP_PASS',
  'config.TELEGRAM_BOT_TOKEN',
  'config.POSTGRES_PASSWORD',
  'pessoa.telefone_whatsapp',
  'telefone_whatsapp',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { pid: process.pid, hostname: 'maia-app' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  transport:
    config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        }
      : undefined,
});

export type Logger = typeof logger;
