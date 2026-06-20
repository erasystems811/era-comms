// ── SPEECH-TO-TEXT INTERFACE ──────────────────────────────────
//
// Abstracts real-time audio transcription. Deepgram is the first
// implementation (targets <300ms latency). Self-hosted Faster-Whisper
// is the second implementation, written after voice is proven and the
// latency budget is understood. The interface is the commitment.

export interface TranscriptChunk {
  text: string
  // TRUE when this is the final transcript for a speech segment.
  // FALSE for interim partials — useful for low-latency display
  // but not passed to the LLM until isFinal = true.
  isFinal: boolean
  confidence?: number
  durationMs?: number
}

export interface STTOptions {
  language?: string           // BCP-47 language code, e.g. 'en-US'
  sampleRate?: number         // default 16000
  encoding?: 'linear16' | 'mulaw' | 'opus'
}

export interface ISTTProvider {
  readonly providerId: string  // 'deepgram' | 'whisper-local'

  // Accepts a stream of audio buffers and yields transcript chunks.
  // The generator runs until the audio stream ends.
  // Must emit at least one chunk with isFinal = true per speech segment.
  transcribe(
    audioStream: AsyncIterable<Buffer>,
    options?: STTOptions,
  ): AsyncIterable<TranscriptChunk>
}
