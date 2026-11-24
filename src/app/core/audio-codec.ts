/**
 * Phone-call quality audio for live listening: 8 kHz mono, G.711 μ-law
 * (1 byte per sample, 8 kB/s ≈ 29 MB an hour). Small, and decodes anywhere.
 */
export const LISTEN_RATE = 8000;

const BIAS = 0x84;
const CLIP = 32635;

export function encodeMulaw(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

export function decodeMulaw(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const u = ~bytes[i] & 0xff;
    const exponent = (u >> 4) & 0x07;
    const sample = (((u & 0x0f) << 3) + BIAS) << exponent;
    out[i] = ((u & 0x80 ? BIAS - sample : sample - BIAS) as number) / 32768;
  }
  return out;
}

/**
 * Collects microphone samples at the device's rate and hands out 8 kHz blocks
 * (each output sample is the average of its input samples, which also filters
 * out sound too high for 8 kHz).
 */
export class Downsampler {
  private readonly ratio: number;
  private pos = 0;
  private acc = 0;
  private n = 0;
  private buf: number[] = [];

  constructor(inputRate: number) {
    this.ratio = inputRate / LISTEN_RATE;
  }

  push(input: Float32Array) {
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.n++;
      this.pos++;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.buf.push(this.acc / this.n);
        this.acc = 0;
        this.n = 0;
      }
    }
  }

  /** Takes a block of exactly `size` samples when that many are ready. */
  take(size: number): Float32Array | null {
    if (this.buf.length < size) return null;
    const block = Float32Array.from(this.buf.slice(0, size));
    this.buf = this.buf.slice(size);
    return block;
  }
}

/** 8 kHz samples → the speaker's rate (linear interpolation). */
export function upsample(samples: Float32Array, outputRate: number): Float32Array {
  const ratio = outputRate / LISTEN_RATE;
  const out = new Float32Array(Math.floor(samples.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i / ratio;
    const a = Math.floor(x);
    const b = Math.min(a + 1, samples.length - 1);
    out[i] = samples[a] + (samples[b] - samples[a]) * (x - a);
  }
  return out;
}

/** Loudness 0–1 for a level meter. */
export function level(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 4);
}
