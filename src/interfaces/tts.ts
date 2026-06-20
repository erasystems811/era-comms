// ── TEXT-TO-SPEECH INTERFACE ──────────────────────────────────
//
// Abstracts speech synthesis. Coqui XTTS v2 (self-hosted) is the
// default — zero marginal cost per call. ElevenLabs is available
// as a premium plan option. The interface is identical for both.
//
// Synthesis streams audio from the first sentence so the voice
// pipeline can begin playback while the rest is still being generated.
// This is how the <1.5s end-to-end latency target is met.

export interface VoiceConfig {
  // XTTS speaker embedding ID from the voice_profiles table (cloned_voice_id)
  voiceId: string
  // 0.5 (slow) to 2.0 (fast). Default 1.0.
  speed?: number
  // BCP-47 language code. Default derived from content.
  language?: string
}

export interface TTSOptions {
  // If true, the stream yields complete audio for the full input text.
  // If false (default), the implementation may yield audio before the
  // full text is processed (sentence-at-a-time streaming).
  waitForCompletion?: boolean
}

export interface ITTSProvider {
  readonly providerId: string  // 'xtts-v2' | 'eleven-labs'

  // Synthesizes text to audio, yielding PCM or encoded audio buffers.
  // Implementations MUST begin yielding data before the full synthesis
  // is complete — sentence-level streaming is the expected behaviour.
  synthesize(
    text: string,
    voice: VoiceConfig,
    options?: TTSOptions,
  ): AsyncIterable<Buffer>

  // Clone a voice from a short audio sample.
  // Returns the voice ID to store in voice_profiles.cloned_voice_id.
  cloneVoice(samplePath: string, name: string): Promise<string>
}
