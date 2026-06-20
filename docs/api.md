# ERA Comms API Reference

ERA Comms is a WhatsApp communication platform that provides infrastructure for sending messages, managing sessions, receiving inbound events via webhooks, and conducting AI-driven voice calls. This document covers every HTTP/WebSocket endpoint.

---

## Base URL

```
https://<your-host>
```

All client API routes are versioned under `/v1`. Operator admin routes are also under `/v1/admin` but use separate authentication.

---

## Authentication

### Client API Keys

All `/v1` routes (except `/health` and `/metrics`) require an API key issued by an ERA Systems operator.

```
X-API-Key: era_<48-hex-chars>
```

API keys are **scoped** — a key may not have permission for every endpoint. The required scope is noted on each route. If the key lacks the required scope the server returns `403 FORBIDDEN`.

Keys are stored hashed and **cannot be retrieved after creation**. Store the raw key immediately.

**Scopes**

| Scope           | Grants access to                                  |
| --------------- | ------------------------------------------------- |
| `messaging`     | Send/read messages and conversation history       |
| `admin`         | Session management, webhook registration          |
| `calls`         | Voice call records (future)                       |
| `conversations` | Read-only conversation access (future)            |
| `analytics`     | Metrics and analytics endpoints (future)          |

### Operator Secret

Routes under `/v1/admin` are for ERA Systems operators only and use a separate shared secret:

```
X-Operator-Secret: <operator-secret>
```

Clients never call these routes.

---

## Common Error Responses

All errors follow this shape:

```json
{ "error": "ERROR_CODE", "message": "Human-readable description" }
```

| HTTP | Code                  | Meaning                                      |
| ---- | --------------------- | -------------------------------------------- |
| 400  | `VALIDATION_ERROR`    | Missing or invalid request field             |
| 401  | `UNAUTHORIZED`        | Missing or invalid API key / operator secret |
| 403  | `FORBIDDEN`           | Key lacks required scope                     |
| 404  | `NOT_FOUND`           | Resource does not exist or belongs to another client |
| 409  | `CONFLICT`            | Resource already exists                      |
| 429  | `PLAN_LIMIT_EXCEEDED` | Hourly / daily / monthly message cap reached |
| 500  | `INTERNAL_ERROR`      | Unexpected server error                      |

---

## Health

### GET /health

Returns the live health of ERA Comms and its dependencies. No authentication required.

**Response 200 — healthy**

```json
{
  "status": "ok",
  "uptime": 3721,
  "checks": {
    "database": "ok",
    "redis": "ok"
  }
}
```

**Response 503 — degraded**

```json
{
  "status": "degraded",
  "uptime": 3721,
  "checks": {
    "database": "ok",
    "redis": "error"
  }
}
```

---

### GET /metrics

Prometheus text-format metrics. No authentication required. Access should be restricted at the network / reverse-proxy level.

---

## Sessions

WhatsApp sessions represent phone numbers registered to the ERA Comms platform. Each session is a persistent WhatsApp Multi-Device connection.

**Scope required:** `admin`

### POST /v1/sessions

Register a new phone number and begin the pairing process.

**Request body**

| Field              | Type                       | Required | Description                                               |
| ------------------ | -------------------------- | -------- | --------------------------------------------------------- |
| `phoneNumber`      | string (E.164)             | yes      | Phone number to register, e.g. `+2348012345678`           |
| `role`             | `"primary"` \| `"backup"`  | no       | Default: `"primary"`                                      |
| `primarySessionId` | UUID                       | no       | Required when `role` is `"backup"` — links to primary     |

```json
{
  "phoneNumber": "+2348012345678",
  "role": "primary"
}
```

**Response 201**

```json
{
  "id": "018f4a2c-3d1e-7b9a-8f2c-1a2b3c4d5e6f",
  "phoneNumber": "+2348012345678",
  "role": "primary",
  "status": "pending_qr"
}
```

After creation, connect to the QR WebSocket (below) to scan the code and complete pairing. Status transitions: `pending_qr` → `connecting` → `connected`.

**Error 400** — invalid phone number format  
**Error 409** — session for this number already exists

---

### GET /v1/sessions

List all sessions for the authenticated client.

**Response 200** — array of session health objects (see GET /v1/sessions/:id)

---

### GET /v1/sessions/:id

Return live health information for one session.

**Response 200**

```json
{
  "sessionId": "018f4a2c-3d1e-7b9a-8f2c-1a2b3c4d5e6f",
  "phoneNumber": "+2348012345678",
  "status": "connected",
  "riskScore": 0.05,
  "lastHeartbeatAt": "2026-06-21T10:45:00.000Z",
  "messagesSentTotal": 1250
}
```

**`status` values**

The health endpoint surfaces two values only. Internal DB states (`pending_qr`, `connecting`, `banned`) are not exposed here.

| Value          | Meaning                                                          |
| -------------- | ---------------------------------------------------------------- |
| `connected`    | Session is active and can send/receive messages                  |
| `disconnected` | Session is not active (pending QR, reconnecting, or banned)      |

**Error 404** — session not found or belongs to another client

---

### DELETE /v1/sessions/:id

Stop a running session. The session worker process is terminated. The database record is retained — the session can be restarted by starting a new worker (contact ERA Systems support) or re-creating if needed.

**Response 204** — no content

---

### GET /v1/sessions/:id/qr (WebSocket)

Stream QR code events during initial device pairing. Connect immediately after creating a session and display the QR code to the operator who will scan it with their WhatsApp mobile app.

**Auth** — WebSocket clients cannot set arbitrary headers in all environments. Pass the API key as a query parameter instead:

```
wss://<host>/v1/sessions/<id>/qr?api_key=era_...
```

**Messages received**

```json
{ "type": "qr", "code": "2@abc123...base64..." }
```

A new QR code is emitted every ~20 seconds (WhatsApp codes expire). The stream closes automatically once the session moves to `connected` status. If the session is not found or the key lacks `admin` scope the WebSocket is closed with code `1008`.

---

## Messages

**Scope required:** `messaging`

### POST /v1/messages

Enqueue an outbound message for delivery. The message is written to the database and added to the outbound BullMQ queue. Delivery is asynchronous.

**Request body**

| Field            | Type           | Required | Description                                                  |
| ---------------- | -------------- | -------- | ------------------------------------------------------------ |
| `sessionId`      | UUID           | yes      | The session that will send this message                      |
| `to`             | string (E.164) | yes      | Recipient phone number                                       |
| `content`        | string         | yes      | Message text                                                 |
| `conversationId` | UUID           | no       | Pin to an existing conversation; a new one is created otherwise |
| `idempotencyKey` | string         | no       | Deduplicate retries — same key within 24 h returns the existing record |

```json
{
  "sessionId": "018f4a2c-3d1e-7b9a-8f2c-1a2b3c4d5e6f",
  "to": "+2347034567890",
  "content": "Hello from ERA Comms",
  "idempotencyKey": "order-789-confirmation"
}
```

**Response 202** — accepted (new message)

```json
{
  "id": "019a1b2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "conversationId": "018c9d0e-1f2a-3b4c-5d6e-7f8a9b0c1d2e",
  "status": "queued",
  "idempotent": false
}
```

**Response 200** — idempotent hit (same `idempotencyKey`, message already exists)

```json
{
  "id": "019a1b2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "conversationId": "018c9d0e-1f2a-3b4c-5d6e-7f8a9b0c1d2e",
  "status": "sent",
  "idempotent": true
}
```

**`status` values:** `queued` → `sent` → `delivered` → `read` | `failed`

**Error 400** — missing/invalid fields  
**Error 429** — plan message limit reached (hourly, daily, or monthly)

---

### GET /v1/messages/:id

Return the current state of a message.

**Response 200**

```json
{
  "id": "019a1b2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "conversationId": "018c9d0e-1f2a-3b4c-5d6e-7f8a9b0c1d2e",
  "direction": "outbound",
  "content": "Hello from ERA Comms",
  "contentType": "text",
  "status": "delivered",
  "waMessageId": "3EB0123456789ABCDEF0",
  "warmupStage": null,
  "aiGenerated": false,
  "createdAt": "2026-06-21T10:45:00.000Z",
  "sentAt": "2026-06-21T10:45:01.234Z"
}
```

**Error 404** — message not found or belongs to another client

---

### GET /v1/messages/conversations

List conversations for the authenticated client, newest first.

**Query parameters**

| Parameter | Default | Max | Description                              |
| --------- | ------- | --- | ---------------------------------------- |
| `limit`   | `50`    | 200 | Number of results to return              |
| `cursor`  | —       | —   | ISO 8601 timestamp for pagination (from `nextCursor`) |

**Response 200**

```json
{
  "data": [
    {
      "id": "018c9d0e-1f2a-3b4c-5d6e-7f8a9b0c1d2e",
      "contactId": "017a8b9c-0d1e-2f3a-4b5c-6d7e8f9a0b1c",
      "sessionId": "018f4a2c-3d1e-7b9a-8f2c-1a2b3c4d5e6f",
      "status": "active",
      "aiActive": true,
      "totalTurns": 12,
      "createdAt": "2026-06-20T08:00:00.000Z",
      "updatedAt": "2026-06-21T10:45:00.000Z"
    }
  ],
  "nextCursor": "2026-06-20T08:00:00.000Z"
}
```

Pass `nextCursor` as `cursor` in the next request to fetch the following page. `nextCursor` is `null` on the last page.

---

### GET /v1/messages/conversations/:id/messages

List messages in a conversation, oldest first.

**Query parameters**

| Parameter | Default | Max | Description                                       |
| --------- | ------- | --- | ------------------------------------------------- |
| `limit`   | `50`    | 200 | Number of results                                 |
| `cursor`  | —       | —   | ISO 8601 timestamp — return messages after this point (for live polling / streaming) |

**Response 200**

```json
{
  "data": [
    {
      "id": "019a1b2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "direction": "outbound",
      "content": "Hello from ERA Comms",
      "contentType": "text",
      "status": "read",
      "waMessageId": "3EB0123456789ABCDEF0",
      "aiGenerated": false,
      "createdAt": "2026-06-21T10:45:00.000Z"
    },
    {
      "id": "019a1b2c-ffff-5f6a-7b8c-9d0e1f2a3b4c",
      "direction": "inbound",
      "content": "Thanks, got it!",
      "contentType": "text",
      "status": "received",
      "waMessageId": "3AB9876543210FEDCBA9",
      "aiGenerated": false,
      "createdAt": "2026-06-21T10:46:12.000Z"
    }
  ],
  "nextCursor": "2026-06-21T10:46:12.000Z"
}
```

**Error 404** — conversation not found or belongs to another client

---

## Webhooks

ERA Comms delivers real-time events (inbound messages, status updates, session events) to registered HTTPS endpoints.

**Scope required:** `admin`

### Webhook payload

Every delivery is an HTTP `POST` to the registered URL with:

```
Content-Type:    application/json
X-ERA-Event:     <event-type>
X-ERA-Delivery-ID: <uuid>
X-ERA-Signature: sha256=<hmac-hex>
X-ERA-Timestamp: <unix-epoch-seconds>
```

The signature is `HMAC-SHA256(rawBody, webhookSecret)`. Always verify it before processing. Use `X-ERA-Timestamp` to reject replays older than a few minutes.

**Event types**

| Event                    | Fired when                                            |
| ------------------------ | ----------------------------------------------------- |
| `message.inbound`        | An inbound WhatsApp message is received               |
| `message.sent`           | A message is accepted by WhatsApp servers             |
| `message.delivered`      | WhatsApp delivers the message to the recipient device |
| `message.read`           | Recipient opens the message                           |
| `message.failed`         | Delivery failed after all retries                     |
| `conversation.escalated` | AI hands off to a human operator                      |
| `conversation.resumed`   | AI re-engages after a human handoff                   |
| `call.completed`         | A voice call ends normally                            |
| `call.failed`            | A voice call ends with an error                       |
| `session.connected`      | A session connects to WhatsApp                        |
| `session.disconnected`   | A session loses its connection                        |
| `session.banned`         | A session is permanently banned by WhatsApp           |

ERA Comms retries failed deliveries with exponential backoff (up to 8 retries over ~24 hours). After all retries the delivery is dead-lettered.

Your endpoint must return a `2xx` status within 10 seconds to be considered successful.

---

### POST /v1/webhooks

Register a new webhook endpoint.

**Request body**

| Field    | Type     | Required | Description                                                              |
| -------- | -------- | -------- | ------------------------------------------------------------------------ |
| `url`    | string   | yes      | HTTPS URL to deliver events to                                           |
| `events` | string[] | no       | Event types to subscribe to. Default: `["message.inbound"]`              |
| `secret` | string   | no       | HMAC signing secret. If omitted, a random 64-hex-char secret is generated |

```json
{
  "url": "https://myapp.example.com/era-webhooks",
  "events": ["message.inbound", "message.delivered", "session.banned"],
  "secret": "my-own-secret"
}
```

**Response 201**

```json
{
  "id": "01ab2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
  "url": "https://myapp.example.com/era-webhooks",
  "events": ["message.inbound", "message.delivered", "session.banned"],
  "secret": "my-own-secret",
  "createdAt": "2026-06-21T10:00:00.000Z"
}
```

The `secret` is returned **once**. If you did not supply one, store the generated value immediately — it cannot be retrieved again.

---

### GET /v1/webhooks

List all registered webhook endpoints. Secrets are never returned.

**Response 200**

```json
[
  {
    "id": "01ab2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
    "url": "https://myapp.example.com/era-webhooks",
    "events": ["message.inbound", "message.delivered"],
    "status": "active",
    "createdAt": "2026-06-21T10:00:00.000Z"
  }
]
```

---

### DELETE /v1/webhooks/:id

Remove a webhook endpoint. In-flight deliveries are not cancelled but no new events are sent.

**Response 204** — no content

---

### GET /v1/webhooks/:id/deliveries

Inspect recent delivery attempts for a webhook endpoint.

**Query parameters**

| Parameter | Default | Max |
| --------- | ------- | --- |
| `limit`   | `50`    | 200 |

**Response 200**

```json
[
  {
    "id": "02bc3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e",
    "eventType": "message.inbound",
    "status": "delivered",
    "attempts": 1,
    "responseStatus": 200,
    "lastAttemptAt": "2026-06-21T10:46:13.000Z",
    "createdAt": "2026-06-21T10:46:12.500Z"
  },
  {
    "id": "03cd4e5f-6a7b-8c9d-0e1f-2a3b4c5d6e7f",
    "eventType": "message.sent",
    "status": "dead_lettered",
    "attempts": 9,
    "responseStatus": 503,
    "lastAttemptAt": "2026-06-22T10:46:13.000Z",
    "createdAt": "2026-06-21T10:50:00.000Z"
  }
]
```

**`status` values:** `pending` | `delivered` | `failed` | `dead_lettered`

---

## Operator Admin

These routes are for ERA Systems operators to manage the platform. Clients do not call them.

**Authentication:** `X-Operator-Secret: <secret>`

All responses follow the same error format. `401` is returned when the secret is missing or wrong.

---

### GET /v1/admin/plans

List all available pricing plans.

**Response 200**

```json
[
  {
    "id": "018d1e2f-3a4b-5c6d-7e8f-9a0b1c2d3e4f",
    "name": "growth",
    "displayName": "Growth",
    "aiEnabled": true,
    "voiceEnabled": false,
    "limits": {
      "monthlyMessages": 50000,
      "dailyMessages": 2000,
      "hourlyMessages": 200,
      "maxSessions": 3
    }
  }
]
```

`null` limits mean unlimited.

---

### POST /v1/admin/clients

Create a new client account.

**Request body**

| Field          | Type                           | Required | Description                         |
| -------------- | ------------------------------ | -------- | ----------------------------------- |
| `name`         | string                         | yes      | Human-readable business name        |
| `planId`       | UUID                           | yes      | Plan to assign (from GET /plans)    |
| `type`         | `"external"` \| `"internal"`   | no       | Default: `"external"`               |
| `categoryId`   | UUID                           | no       | Industry / vertical classification  |
| `contactEmail` | string                         | no       | Billing or contact email            |

**Response 201**

```json
{
  "id": "01bc2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e",
  "name": "Acme Corp",
  "type": "external",
  "createdAt": "2026-06-21T09:00:00.000Z"
}
```

---

### GET /v1/admin/clients

List all client accounts.

**Response 200**

```json
[
  {
    "id": "01bc2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e",
    "name": "Acme Corp",
    "type": "external",
    "status": "active",
    "plan": { "id": "...", "name": "growth" },
    "contactEmail": "billing@acme.example.com",
    "createdAt": "2026-06-21T09:00:00.000Z"
  }
]
```

---

### GET /v1/admin/clients/:id

Return a client's profile plus their live message usage from Redis counters.

**Response 200**

```json
{
  "id": "01bc2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e",
  "name": "Acme Corp",
  "type": "external",
  "status": "active",
  "plan": { "id": "...", "name": "growth" },
  "contactEmail": "billing@acme.example.com",
  "createdAt": "2026-06-21T09:00:00.000Z",
  "usage": {
    "messagesThisHour":  { "used": 47,   "cap": 200   },
    "messagesThisDay":   { "used": 831,  "cap": 2000  },
    "messagesThisMonth": { "used": 12043,"cap": 50000 }
  }
}
```

`cap` is `null` for unlimited plans.

---

### PATCH /v1/admin/clients/:id

Update a client's plan, status, or contact email. All fields are optional; only supplied fields are updated.

**Request body**

| Field          | Type                            | Description                          |
| -------------- | ------------------------------- | ------------------------------------ |
| `planId`       | UUID                            | Migrate client to a different plan   |
| `status`       | `"active"` \| `"suspended"`     | Suspend or reinstate a client        |
| `contactEmail` | string \| null                  | Update contact email                 |

**Response 204** — no content

---

### POST /v1/admin/clients/:id/api-keys

Issue a new API key for a client.

**Request body**

| Field         | Type                      | Required | Description                                               |
| ------------- | ------------------------- | -------- | --------------------------------------------------------- |
| `scopes`      | string[]                  | no       | Default: `["messaging"]`. Valid: `messaging`, `calls`, `conversations`, `analytics`, `admin` |
| `environment` | `"live"` \| `"test"`      | no       | Default: `"live"`                                         |
| `expiresAt`   | ISO 8601 datetime          | no       | Expiry date; omit for non-expiring keys                   |

```json
{
  "scopes": ["messaging", "admin"],
  "environment": "live",
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

**Response 201**

```json
{
  "id": "02cd3e4f-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
  "key": "era_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6",
  "keyPrefix": "era_a1b2c3d4",
  "scopes": ["messaging", "admin"],
  "environment": "live",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "createdAt": "2026-06-21T09:00:00.000Z"
}
```

The `key` field is the raw API key and is returned **once**. Deliver it securely to the client — it cannot be retrieved again. The `keyPrefix` is safe to store and display (it identifies the key without revealing the secret).

---

### GET /v1/admin/clients/:id/api-keys

List all API keys for a client. Raw key values are never returned.

**Response 200**

```json
[
  {
    "id": "02cd3e4f-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
    "keyPrefix": "era_a1b2c3d4",
    "scopes": ["messaging", "admin"],
    "environment": "live",
    "status": "active",
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "createdAt": "2026-06-21T09:00:00.000Z"
  }
]
```

**`status` values:** `active` | `revoked`

---

### DELETE /v1/admin/api-keys/:keyId

Revoke an API key immediately. All subsequent requests using this key return `401`.

**Response 204** — no content

---

## Rate Limiting & Quotas

Message sending is gated against three independent counters per client (stored in Redis):

| Window  | Counter resets             |
| ------- | -------------------------- |
| Hourly  | Top of each hour (UTC)     |
| Daily   | Midnight UTC               |
| Monthly | First day of the month UTC |

When any cap is exceeded, `POST /v1/messages` returns `429 PLAN_LIMIT_EXCEEDED`. The error body indicates which window was hit:

```json
{
  "error": "PLAN_LIMIT_EXCEEDED",
  "message": "hourly message limit reached"
}
```

Plan caps are visible via `GET /v1/admin/clients/:id`.
