import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { decodeMulaw, level, upsample } from './audio-codec';
import { readEvents } from './live.service';

/**
 * The owner's side of live listening: reads the session's audio stream and
 * plays it with a small buffer (about ⅓ s) so short network gaps don't click.
 * Must be started from a tap (browsers only allow sound after one).
 */
export class ListenPlayer {
  readonly state = signal<'connecting' | 'waiting' | 'live' | 'ended'>('connecting');
  readonly level = signal(0);
  private readonly ctx = new AudioContext();
  private readonly control = new AbortController();
  private nextAt = 0;
  private lastAudio = 0;
  private watchdog?: ReturnType<typeof setInterval>;

  /** Create it right in the tap handler, before awaiting anything, so the browser allows sound. */
  constructor(private readonly auth: AuthService) {
    void this.ctx.resume();
  }

  connect(businessId: string, sessionId: string, onEnded: () => void) {
    this.watchdog = setInterval(() => {
      if (this.state() === 'live' && Date.now() - this.lastAudio > 4000) this.state.set('waiting');
      if (Date.now() - this.lastAudio > 400) this.level.set(0);
    }, 500);
    void this.run(businessId, sessionId).finally(() => {
      if (this.state() !== 'ended') this.state.set('ended');
      onEnded();
    });
  }

  private async run(businessId: string, sessionId: string) {
    const res = await this.auth.fetch(`/api/shops/${encodeURIComponent(businessId)}/listen/${sessionId}/stream`, {
      headers: { Accept: 'text/event-stream' },
      signal: this.control.signal,
    });
    if (!res.ok || !res.body) return;
    this.state.set('waiting');
    await readEvents(res.body, (event, data) => {
      if (event === 'audio') this.play(data);
      if (event === 'ended') this.control.abort();
    }).catch(() => undefined);
  }

  private play(base64: string) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const samples = decodeMulaw(bytes);
    this.level.set(level(samples));
    this.lastAudio = Date.now();
    this.state.set('live');
    const pcm = upsample(samples, this.ctx.sampleRate);
    const buffer = this.ctx.createBuffer(1, pcm.length, this.ctx.sampleRate);
    buffer.getChannelData(0).set(pcm);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    // fell behind (gap) or drifted too far ahead: restart the small buffer
    if (this.nextAt < now || this.nextAt > now + 2) this.nextAt = now + 0.35;
    src.start(this.nextAt);
    this.nextAt += buffer.duration;
  }

  close() {
    clearInterval(this.watchdog);
    this.control.abort();
    this.state.set('ended');
    void this.ctx.close().catch(() => undefined);
  }
}
