import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(20),

  // Redis
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // AI provider keys — ERA Comms infrastructure keys, never exposed to clients
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // AES-256-GCM key for session credential encryption (32 bytes as 64 hex chars)
  SESSION_CREDENTIALS_KEY: z
    .string()
    .length(64, 'SESSION_CREDENTIALS_KEY must be 64 hex characters (32 bytes)'),

  // Operator REST API secret — required for /v1/admin/* routes
  OPERATOR_SECRET: z.string().min(32, 'OPERATOR_SECRET must be at least 32 characters'),

  // Shared secret baked into ERAConnect.exe — authenticates telemetry from hospital agents
  CONNECT_SHARED_SECRET: z.string().default('era-connect-telemetry-v1'),

  // Operator alert destination
  ALERT_WHATSAPP_NUMBER: z.string().min(1, 'ALERT_WHATSAPP_NUMBER is required'),

  // The ERA Systems internal client — pre-seeded by migration 004
  OPERATOR_INTERNAL_CLIENT_ID: z.string().uuid().default('c0ffee00-0000-4000-a000-000000000001'),

  EMAIL_FROM: z.preprocess(v => (typeof v === 'string' ? v.trim() : v), z.string().optional().default('noreply@erasystems.com.ng')),

  // Postal — self-hosted email server on your VPS (all email — transactional + campaigns)
  POSTAL_SERVER_URL:      z.preprocess(v => (v === '' ? undefined : v), z.string().url().optional()),
  POSTAL_API_KEY:         z.preprocess(v => (v === '' ? undefined : v), z.string().optional()),
  POSTAL_RATE_LIMIT:      z.coerce.number().int().default(50),
  POSTAL_WEBHOOK_SECRET:  z.preprocess(v => (v === '' ? undefined : v), z.string().optional()),
  PUBLIC_URL:             z.preprocess(v => (v === '' ? undefined : v), z.string().url().optional()).default('https://xeyfmi3l8l5m.share.zrok.io'),

  // Voice infrastructure — only started when ENABLE_VOICE=true
  ENABLE_VOICE: z.preprocess(v => v === 'true' || v === '1', z.boolean()).default(false),

  SIP_TRUNK_HOST: z.string().optional(),
  SIP_TRUNK_USERNAME: z.string().optional(),
  SIP_TRUNK_PASSWORD: z.string().optional(),
  SIP_TRUNK_FROM_NUMBER: z.string().optional(),

  FREESWITCH_HOST: z.string().default('localhost'),
  FREESWITCH_ESL_PORT: z.coerce.number().int().default(8021),
  FREESWITCH_ESL_PASSWORD: z.string().default('ClueCon'),

  TTS_SERVICE_URL: z.string().url().default('http://localhost:5002'),
  DEEPGRAM_API_KEY: z.string().optional(),
  VOICE_AUDIO_DIR: z.string().default('/tmp/era-voice'),
})

const result = schema.safeParse(process.env)

if (!result.success) {
  const issues = result.error.issues
    .map(i => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  console.error(`ERA Comms startup failed — invalid configuration:\n${issues}`)
  process.exit(1)
}

const env = result.data

export const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isStaging: env.NODE_ENV === 'staging',
  isDevelopment: env.NODE_ENV === 'development',

  server: {
    port: env.PORT,
    host: env.HOST,
  },

  db: {
    url: env.DATABASE_URL,
    maxConnections: env.DATABASE_MAX_CONNECTIONS,
  },

  redis: {
    url: env.REDIS_URL,
  },

  ai: {
    openaiApiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  },

  encryption: {
    // Stored as hex string, exposed as Buffer for use with crypto module
    sessionCredentialsKey: Buffer.from(env.SESSION_CREDENTIALS_KEY, 'hex'),
  },

  operatorSecret: env.OPERATOR_SECRET,
  connectSharedSecret: env.CONNECT_SHARED_SECRET,

  email: {
    from:                env.EMAIL_FROM ?? 'noreply@erasystems.com.ng',
    postalServerUrl:     env.POSTAL_SERVER_URL,
    postalApiKey:        env.POSTAL_API_KEY,
    postalRateLimit:     env.POSTAL_RATE_LIMIT,
    postalWebhookSecret: env.POSTAL_WEBHOOK_SECRET,
  },

  publicUrl: env.PUBLIC_URL ?? 'https://xeyfmi3l8l5m.share.zrok.io',

  monitoring: {
    alertWhatsappNumber: env.ALERT_WHATSAPP_NUMBER,
    operatorInternalClientId: env.OPERATOR_INTERNAL_CLIENT_ID,
  },

  voice: {
    enabled: env.ENABLE_VOICE,
    sip: {
      host: env.SIP_TRUNK_HOST,
      username: env.SIP_TRUNK_USERNAME,
      password: env.SIP_TRUNK_PASSWORD,
      fromNumber: env.SIP_TRUNK_FROM_NUMBER,
    },
    freeswitch: {
      host: env.FREESWITCH_HOST,
      eslPort: env.FREESWITCH_ESL_PORT,
      eslPassword: env.FREESWITCH_ESL_PASSWORD,
    },
    tts: {
      serviceUrl: env.TTS_SERVICE_URL,
    },
    deepgramApiKey: env.DEEPGRAM_API_KEY,
    audioDir: env.VOICE_AUDIO_DIR,
  },
})

export type Config = typeof config
