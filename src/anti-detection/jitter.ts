// ── JITTER ENGINE ─────────────────────────────────────────────
//
// Calculates humanising delays before and during message sends.
// concurrency: 1 per session means one call at a time — these
// values are not shared across goroutines.

export type WarmupStage = 'conversational' | 'light_cta' | 'unrestricted'

export interface JitterResult {
  composingMs: number  // duration to hold the "typing…" indicator
  delayMs: number      // additional quiet pause before sending
}

// Pre-send quiet pause ranges by warmup stage (ms)
const DELAY_RANGES: Record<WarmupStage, [number, number]> = {
  conversational: [3_000, 15_000],
  light_cta:      [2_000, 10_000],
  unrestricted:   [800,   5_000],
}

// Simulates composing at 30-60 WPM.
// Clamps to [800ms, 8s] — sub-second composing looks robotic;
// above 8s looks like the device froze.
function composingDuration(charCount: number): number {
  const wpm = 30 + Math.random() * 30
  const baseMs = (charCount / (wpm * 5)) * 60_000
  const withVariance = baseMs * (0.8 + Math.random() * 0.4)
  return Math.round(Math.max(800, Math.min(withVariance, 8_000)))
}

function randomBetween(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min))
}

export function calculateJitter(stage: WarmupStage, messageLength: number): JitterResult {
  const [min, max] = DELAY_RANGES[stage]
  return {
    composingMs: composingDuration(messageLength),
    delayMs:     randomBetween(min, max),
  }
}
