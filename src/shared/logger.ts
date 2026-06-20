import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: config.isDevelopment ? 'debug' : 'info',
  transport: config.isDevelopment
    ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
    : undefined,
  base: {
    env: config.env,
    service: 'era-comms',
  },
  redact: {
    paths: [
      'req.headers.authorization',
      '*.api_key',
      '*.key_hash',
      '*.credentials_encrypted',
      '*.openai_api_key',
      '*.anthropic_api_key',
    ],
    censor: '[REDACTED]',
  },
})

export type Logger = typeof logger
