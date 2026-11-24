import { Downsampler, LISTEN_RATE, decodeMulaw, encodeMulaw, upsample } from './audio-codec';

describe('live listening audio', () => {
  it('μ-law round trip keeps the sound within a few percent', () => {
    const tone = Float32Array.from({ length: 800 }, (_, i) => 0.6 * Math.sin((2 * Math.PI * 440 * i) / LISTEN_RATE));
    const back = decodeMulaw(encodeMulaw(tone));
    for (let i = 0; i < tone.length; i++) expect(Math.abs(back[i] - tone[i])).toBeLessThan(0.03);
    expect(Math.abs(decodeMulaw(encodeMulaw(new Float32Array([0])))[0])).toBeLessThan(0.001);
  });

  it('48 kHz microphone input becomes 8 kHz blocks', () => {
    const d = new Downsampler(48000);
    d.push(new Float32Array(48000).fill(0.5));
    const block = d.take(4000);
    expect(block?.length).toBe(4000);
    expect(block?.[10]).toBeCloseTo(0.5);
    expect(d.take(4001)).toBeNull();
  });

  it('upsamples to the speaker rate', () => {
    expect(upsample(new Float32Array(800), 48000).length).toBe(4800);
  });
});
