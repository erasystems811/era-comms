// ── FREESWITCH ESL INBOUND CLIENT ─────────────────────────────
//
// Connects to FreeSWITCH's Event Socket Layer (port 8021) in inbound
// mode. Authenticates, subscribes to call events, and provides
// sendmsg() for per-channel app execution.
//
// ESL message framing:
//   Header-Name: value\n
//   ...
//   \n
//   [body — only present when Content-Length header is set]
//
// Completion of sendmsg commands is signalled by CHANNEL_EXECUTE_COMPLETE
// events (which include Unique-ID and Application), not by command/reply.
// This avoids reply-correlation problems when driving multiple concurrent
// calls over a single ESL socket.

import net from 'node:net'
import EventEmitter from 'node:events'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ component: 'esl-client' })

export type ESLEvent = Record<string, string>

// ESL events ERA Comms cares about
const SUBSCRIBED_EVENTS = [
  'CHANNEL_CREATE',
  'CHANNEL_HANGUP',
  'CHANNEL_ANSWER',
  'CHANNEL_EXECUTE_COMPLETE',
  'RECORD_STOP',
  'DTMF',
].join(' ')

export class ESLClient extends EventEmitter {
  private socket: net.Socket | null = null
  private buf = ''
  private authenticated = false
  // Pending callbacks for command/reply and api/response acks (FIFO)
  private pendingReplies: Array<(text: string) => void> = []

  async connect(): Promise<void> {
    const { host, eslPort, eslPassword } = config.voice.freeswitch

    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port: eslPort }, () => {
        log.info({ host, eslPort }, 'ESL connected to FreeSWITCH')
      })
      this.socket = sock
      sock.setEncoding('utf8')
      sock.setNoDelay(true)

      sock.on('data', (chunk: string) => {
        this.buf += chunk
        this.drain()
      })

      sock.on('error', (err) => {
        if (!this.authenticated) reject(err)
        else { log.error({ err }, 'ESL socket error'); this.emit('error', err) }
      })

      sock.on('close', () => {
        this.authenticated = false
        log.warn('ESL socket closed')
        this.emit('disconnect')
      })

      // Once authenticated (resolved internally), subscribe and resolve the outer promise
      this.once('_authenticated', async () => {
        await this.send(`event json ${SUBSCRIBED_EVENTS}`)
        resolve()
      })

      this.once('_authFailed', (reason: string) => {
        reject(new Error(`ESL auth failed: ${reason}`))
      })

      // Start: auth/request comes from server; handler in drain() replies
      const eslPassword_ = eslPassword
      this.once('_authRequest', () => {
        sock.write(`auth ${eslPassword_}\n\n`)
      })
    })
  }

  // Execute a FreeSWITCH app on a specific channel.
  // Returns immediately after sending — caller uses executeAndWait() for
  // completion tracking via CHANNEL_EXECUTE_COMPLETE events.
  sendmsg(uuid: string, app: string, arg?: string): void {
    const lines = [
      `sendmsg ${uuid}`,
      'call-command: execute',
      `execute-app-name: ${app}`,
      ...(arg !== undefined ? [`execute-app-arg: ${arg}`] : []),
      'event-lock: true',
    ]
    this.socket?.write(lines.join('\n') + '\n\n')
  }

  // Execute and wait for CHANNEL_EXECUTE_COMPLETE or CHANNEL_HANGUP.
  executeAndWait(uuid: string, app: string, arg?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('CHANNEL_EXECUTE_COMPLETE', onComplete)
        this.off('CHANNEL_HANGUP', onHangup)
        reject(new Error(`ESL executeAndWait timed out: ${app} on ${uuid}`))
      }, 120_000)
      timer.unref()

      const onComplete = (evt: ESLEvent) => {
        if (evt['Unique-ID'] !== uuid || evt['Application'] !== app) return
        clearTimeout(timer)
        this.off('CHANNEL_EXECUTE_COMPLETE', onComplete)
        this.off('CHANNEL_HANGUP', onHangup)
        resolve()
      }
      const onHangup = (evt: ESLEvent) => {
        if (evt['Unique-ID'] !== uuid) return
        clearTimeout(timer)
        this.off('CHANNEL_EXECUTE_COMPLETE', onComplete)
        this.off('CHANNEL_HANGUP', onHangup)
        reject(new Error('Call hung up during execute'))
      }

      this.on('CHANNEL_EXECUTE_COMPLETE', onComplete)
      this.on('CHANNEL_HANGUP', onHangup)
      this.sendmsg(uuid, app, arg)
    })
  }

  // Send an ESL API command and return the response body.
  api(command: string): Promise<string> {
    return new Promise((resolve) => {
      this.pendingReplies.push(resolve)
      this.socket?.write(`api ${command}\n\n`)
    })
  }

  close(): void {
    this.socket?.end()
  }

  // ── PRIVATE ────────────────────────────────────────────────────

  private async send(msg: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket?.write(`${msg}\n\n`, (err) => {
        if (err) reject(err); else resolve()
      })
    })
  }

  private drain(): void {
    while (true) {
      const sep = this.buf.indexOf('\n\n')
      if (sep === -1) break

      const headerBlock = this.buf.slice(0, sep)
      const headers = parseHeaders(headerBlock)
      const bodyLen = parseInt(headers['Content-Length'] ?? '0', 10)
      const totalLen = sep + 2 + bodyLen

      if (this.buf.length < totalLen) break

      const body = bodyLen > 0 ? this.buf.slice(sep + 2, totalLen) : null
      this.buf = this.buf.slice(totalLen)

      this.dispatch(headers, body)
    }
  }

  private dispatch(headers: Record<string, string>, body: string | null): void {
    const ct = headers['Content-Type']

    if (ct === 'auth/request') {
      this.emit('_authRequest')
      return
    }

    if (ct === 'command/reply') {
      const reply = headers['Reply-Text'] ?? ''
      if (!this.authenticated) {
        if (reply.startsWith('+OK')) {
          this.authenticated = true
          this.emit('_authenticated')
        } else {
          this.emit('_authFailed', reply)
        }
        return
      }
      const cb = this.pendingReplies.shift()
      cb?.(reply)
      return
    }

    if (ct === 'api/response' && body !== null) {
      const cb = this.pendingReplies.shift()
      cb?.(body.trim())
      return
    }

    if (ct === 'text/event-json' && body) {
      let evt: ESLEvent
      try {
        evt = JSON.parse(body) as ESLEvent
      } catch {
        log.warn({ body: body.slice(0, 80) }, 'ESL: failed to parse event JSON')
        return
      }
      const name = evt['Event-Name']
      if (name) this.emit(name, evt)
      this.emit('event', evt)
    }
  }
}

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
