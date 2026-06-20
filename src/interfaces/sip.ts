// ── SIP TRUNK AND CALL SESSION INTERFACES ────────────────────
//
// The SIP trunk is the only external dependency for voice that cannot
// be avoided — it provides PSTN last-mile access to real phone numbers.
// Everything else in the voice pipeline is owned infrastructure.
//
// FreeSWITCH manages media; this interface abstracts the carrier trunk.

export interface CallOptions {
  to: string           // E.164 recipient number
  from: string         // CLI / caller ID to present
  timeoutSeconds?: number  // ring timeout before treating as no_answer
}

export type CallEndReason = 'completed' | 'no_answer' | 'busy' | 'failed' | 'hangup_by_caller'

// Represents one active call session. The voice pipeline holds this
// for the duration of the call.
export interface ICallSession {
  readonly callId: string        // internal call ID
  readonly freeswitchUuid: string

  // Stream audio into the call (from TTS output)
  sendAudio(audioStream: AsyncIterable<Buffer>): Promise<void>

  // Receive audio from the call (to STT input)
  receiveAudio(): AsyncIterable<Buffer>

  // Hang up the call
  hangup(): Promise<void>

  // Register a handler for when the far end hangs up
  onHangup(handler: (reason: CallEndReason) => void): void

  // Returns elapsed seconds since answered_at
  getDuration(): number
}

export interface ISIPTrunk {
  readonly providerId: string

  // Originate an outbound call. Returns when the call is ringing.
  // Throws on immediate failure (invalid number, trunk error).
  // The caller must poll or await onHangup for final status.
  call(options: CallOptions): Promise<ICallSession>
}
