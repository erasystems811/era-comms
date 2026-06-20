export class ERAError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
  ) {
    super(message)
    this.name = 'ERAError'
  }
}

// 400 — request is malformed or fails validation
export class ValidationError extends ERAError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message, 400)
    this.name = 'ValidationError'
  }
}

// 401 — no valid API key presented
export class AuthenticationError extends ERAError {
  constructor(message = 'Invalid or missing API key') {
    super('AUTHENTICATION_ERROR', message, 401)
    this.name = 'AuthenticationError'
  }
}

// 403 — key is valid but lacks the required scope
export class AuthorizationError extends ERAError {
  constructor(message: string) {
    super('AUTHORIZATION_ERROR', message, 403)
    this.name = 'AuthorizationError'
  }
}

// 404
export class NotFoundError extends ERAError {
  constructor(resource: string) {
    super('NOT_FOUND', `${resource} not found`, 404)
    this.name = 'NotFoundError'
  }
}

// 409 — idempotency key already used (returns original result, not thrown as error)
// Or state conflict (e.g. session already connected)
export class ConflictError extends ERAError {
  constructor(message: string) {
    super('CONFLICT', message, 409)
    this.name = 'ConflictError'
  }
}

// 429 — API rate limit hit
export class RateLimitError extends ERAError {
  constructor(retryAfterSeconds: number) {
    super('RATE_LIMIT_EXCEEDED', `Rate limit exceeded. Retry after ${retryAfterSeconds}s`, 429)
    this.name = 'RateLimitError'
  }
}

// 429 — client has exhausted their plan message cap
export class PlanLimitError extends ERAError {
  readonly limitType: 'hourly' | 'daily' | 'monthly'
  constructor(limitType: 'hourly' | 'daily' | 'monthly') {
    super('PLAN_LIMIT_EXCEEDED', `${limitType} message limit reached`, 429)
    this.limitType = limitType
    this.name = 'PlanLimitError'
  }
}

// 503 — WhatsApp session unavailable
export class SessionError extends ERAError {
  constructor(message: string) {
    super('SESSION_ERROR', message, 503)
    this.name = 'SessionError'
  }
}

// Internal — AI provider returned an error
export class AIProviderError extends ERAError {
  constructor(provider: string, message: string) {
    super('AI_PROVIDER_ERROR', `[${provider}] ${message}`, 502)
    this.name = 'AIProviderError'
  }
}

// Internal — queue operation failed
export class QueueError extends ERAError {
  constructor(message: string) {
    super('QUEUE_ERROR', message, 500)
    this.name = 'QueueError'
  }
}
