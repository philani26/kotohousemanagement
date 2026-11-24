import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { DocumentReference, Query, revive } from './db';

type Listener = () => void;

/**
 * Reads shop records from the Java backend and keeps screens up to date.
 * One server-sent-events connection per shop says which collections changed;
 * every open list of that collection reloads (what Firestore's onSnapshot did).
 * After a reconnect everything reloads, so nothing missed while offline stays stale.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly auth = inject(AuthService);
  /** businessId → collection → listeners */
  private readonly listeners = new Map<string, Map<string, Set<Listener>>>();
  private readonly streams = new Map<string, AbortController>();

  async query<T>(q: Query): Promise<T[]> {
    const res = await this.auth.fetch(`/api/shops/${encodeURIComponent(q.businessId)}/query`, {
      method: 'POST',
      body: JSON.stringify({ collection: q.collection, where: q.where, orderBy: q.orderBy, limit: q.limit }),
    });
    if (!res.ok) throw await problem(res);
    return revive((await res.json()) as T[]);
  }

  async get<T>(ref: DocumentReference): Promise<T | null> {
    const res = await this.auth.fetch(`/api/shops/${encodeURIComponent(ref.businessId)}/data/${encodeURIComponent(ref.collection)}/${encodeURIComponent(ref.id)}`);
    if (res.status === 204) return null;
    if (!res.ok) throw await problem(res);
    const text = await res.text();
    return text ? revive(JSON.parse(text) as T) : null;
  }

  /** Calls onChange whenever the collection changes in that shop. Returns a function to stop. */
  watch(businessId: string, collection: string, onChange: Listener): () => void {
    let byCollection = this.listeners.get(businessId);
    if (!byCollection) {
      byCollection = new Map();
      this.listeners.set(businessId, byCollection);
    }
    let set = byCollection.get(collection);
    if (!set) {
      set = new Set();
      byCollection.set(collection, set);
    }
    set.add(onChange);
    this.connect(businessId);
    return () => {
      set!.delete(onChange);
      if (![...byCollection!.values()].some((s) => s.size)) this.disconnect(businessId);
    };
  }

  private notify(businessId: string, collections: string[] | null) {
    const byCollection = this.listeners.get(businessId);
    if (!byCollection) return;
    for (const [c, set] of byCollection) if (!collections || collections.includes(c)) set.forEach((l) => l());
  }

  private disconnect(businessId: string) {
    this.streams.get(businessId)?.abort();
    this.streams.delete(businessId);
  }

  private connect(businessId: string) {
    if (this.streams.has(businessId)) return;
    const control = new AbortController();
    this.streams.set(businessId, control);
    void this.run(businessId, control);
  }

  private async run(businessId: string, control: AbortController) {
    let delay = 1_000;
    let first = true;
    while (!control.signal.aborted) {
      try {
        const res = await this.auth.fetch(`/api/shops/${encodeURIComponent(businessId)}/events`, {
          headers: { Accept: 'text/event-stream' },
          signal: control.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        // reconnected: reload everything in case changes were missed
        if (!first) this.notify(businessId, null);
        first = false;
        delay = 1_000;
        await readEvents(res.body, (event, data) => {
          if (event === 'changed') {
            try {
              this.notify(businessId, JSON.parse(data) as string[]);
            } catch {
              this.notify(businessId, null);
            }
          }
        });
      } catch {
        if (control.signal.aborted) return;
      }
      first = false;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

/** Minimal text/event-stream reader. */
export async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, data.join('\n'));
    }
  }
}

/** An error from the backend, with its code (e.g. permission-denied). */
export async function problem(res: Response): Promise<Error & { code?: string }> {
  try {
    const body = (await res.json()) as { code?: string; message?: string };
    return Object.assign(new Error(body.message ?? `Error ${res.status}`), { code: body.code });
  } catch {
    return Object.assign(new Error(`Error ${res.status}`), { code: String(res.status) });
  }
}
