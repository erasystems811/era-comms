// Fastify module augmentation — extends FastifyInstance and FastifyRequest
// with ERA Comms properties. TypeScript picks this up from src/**/* compilation.

import type { ISessionSupervisor } from '../interfaces/session.js'

declare module 'fastify' {
  interface FastifyInstance {
    supervisor: ISessionSupervisor
  }
  interface FastifyRequest {
    clientId: string
    apiKeyId: string
    scopes: string[]
    clientType: 'internal' | 'external'
  }
}

export {}
