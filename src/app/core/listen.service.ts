import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ListenSession } from '@shared/devices';
import { AuthService } from './auth.service';
import { BusinessService } from './business.service';
import { Downsampler, LISTEN_RATE, encodeMulaw } from './audio-codec';
import { deviceId } from './device-id';
import { liveDoc } from './live';

/** half a second of 8 kHz audio per upload */
const BLOCK = LISTEN_RATE / 2;

/**
 * The shop-device side of live listening. When the owner starts listening to
 * this device, the server sets listenSessions/{this device}; this service then
 * sends the microphone to the server and the app shows a banner the whole
 * time. It stops when the owner stops, when the server says the session ended,
 * or when someone signs out. Nothing is stored on the device or the server.
 */
@Injectable({ providedIn: 'root' })
export class ListenService {
  private readonly auth = inject(AuthService);
  private readonly biz = inject(BusinessService);
  private readonly id = deviceId();

  private readonly record = liveDoc<ListenSession>(() =>
    this.auth.uid() && this.auth.businessId() ? this.biz.docRef('listenSessions', this.id) : null,
  );
  /** the owner asked to listen to this device */
  readonly requested = computed(() => {
    const r = this.record.data();
    return r?.active ? r : null;
  });
  /** the microphone is actually on */
  readonly live = signal(false);
  /** why the microphone could not start (shown in the banner) */
  readonly problem = signal<string | null>(null);

  private current: { sessionId: string; stop: () => void } | null = null;

  constructor() {
    effect(() => {
      const r = this.requested();
      untracked(() => {
        if (r && r.sessionId !== this.current?.sessionId) void this.start(r);
        if (!r && this.current) this.stop();
      });
    });
  }

  /** The banner's button: lets the browser start audio after a tap if it held it back. */
  async resume() {
    const r = this.requested();
    if (r && !this.live()) {
      this.stop();
      await this.start(r);
    }
  }

  private async start(r: ListenSession) {
    this.stop();
    const businessId = this.auth.businessId();
    if (!businessId || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.problem.set('This browser cannot share the microphone');
      return;
    }
    let stopped = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    const stop = () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      this.live.set(false);
    };
    this.current = { sessionId: r.sessionId, stop };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
      if (stopped) return stop();
      ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
      if (ctx.state !== 'running') {
        this.problem.set('Tap the banner to let the microphone start');
        return stop();
      }
      const source = ctx.createMediaStreamSource(stream);
      // ScriptProcessor works in every browser; a silent gain keeps it running without playing anything
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(ctx.destination);
      const down = new Downsampler(ctx.sampleRate);
      let sending = Promise.resolve();
      processor.onaudioprocess = (e) => {
        if (stopped) return;
        down.push(e.inputBuffer.getChannelData(0));
        let block: Float32Array | null;
        while ((block = down.take(BLOCK))) {
          const bytes = encodeMulaw(block);
          sending = sending.then(() => this.send(businessId, r.sessionId, bytes)).then((active) => {
            if (!active && !stopped) this.stopIf(r.sessionId);
          });
        }
      };
      this.problem.set(null);
      this.live.set(true);
    } catch (err) {
      const name = (err as Error).name;
      this.problem.set(
        name === 'NotAllowedError'
          ? 'The microphone is blocked for Kota House on this device – allow it in the browser settings'
          : 'The microphone could not start',
      );
      stop();
    }
  }

  private async send(businessId: string, sessionId: string, bytes: Uint8Array): Promise<boolean> {
    try {
      const res = await this.auth.fetch(`/api/shops/${encodeURIComponent(businessId)}/listen/${sessionId}/audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Device-Id': this.id },
        body: bytes as BodyInit,
      });
      if (!res.ok) return res.status >= 500; // keep trying through server hiccups; stop when refused
      return ((await res.json()) as { active: boolean }).active;
    } catch {
      return true; // offline for a moment: keep going, the owner hears a gap
    }
  }

  private stopIf(sessionId: string) {
    if (this.current?.sessionId === sessionId) this.stop();
  }

  private stop() {
    this.current?.stop();
    this.current = null;
  }
}
