import { Signal, effect, inject, signal, untracked } from '@angular/core';
import { CollectionReference, DocumentReference, Query, query } from './db';
import { LiveService } from './live.service';

export interface Live<T> {
  data: Signal<T>;
  loading: Signal<boolean>;
  error: Signal<string | null>;
}

const RELOAD_DEBOUNCE_MS = 150;

/**
 * A list of shop records as a signal that stays up to date. The query factory
 * may read other signals (filters); the list reloads when they change, and
 * whenever the server says the collection changed. Stops when the component
 * is destroyed. Must run in an injection context.
 */
export function liveQuery<T>(factory: () => Query | CollectionReference | null): Live<T[]> {
  const live = inject(LiveService);
  const data = signal<T[]>([]);
  const loading = signal(true);
  const error = signal<string | null>(null);
  effect((onCleanup) => {
    const ref = factory();
    untracked(() => loading.set(true));
    if (!ref) {
      untracked(() => {
        data.set([]);
        loading.set(false);
      });
      return;
    }
    const q = ref.kind === 'query' ? ref : query(ref);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      try {
        const rows = await live.query<T>(q);
        if (stopped || mine !== seq) return;
        data.set(rows);
        error.set(null);
      } catch (err) {
        if (stopped || mine !== seq) return;
        console.error(err);
        const e = err as { code?: string; message?: string };
        error.set(e.code === 'permission-denied' ? 'You do not have access to this information' : (e.message ?? 'Could not load'));
      } finally {
        if (!stopped && mine === seq) loading.set(false);
      }
    };
    const unwatch = live.watch(q.businessId, q.collection, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), RELOAD_DEBOUNCE_MS);
    });
    void load();
    onCleanup(() => {
      stopped = true;
      clearTimeout(timer);
      unwatch();
    });
  });
  return { data, loading, error };
}

/** One shop record as a signal that stays up to date (null while it doesn't exist). */
export function liveDoc<T>(factory: () => DocumentReference | null): Live<T | null> {
  const live = inject(LiveService);
  const data = signal<T | null>(null);
  const loading = signal(true);
  const error = signal<string | null>(null);
  effect((onCleanup) => {
    const ref = factory();
    if (!ref) {
      untracked(() => {
        data.set(null);
        loading.set(false);
      });
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const row = await live.get<T>(ref);
        if (stopped) return;
        data.set(row);
        error.set(null);
      } catch (err) {
        if (!stopped) error.set((err as Error).message);
      } finally {
        if (!stopped) loading.set(false);
      }
    };
    const unwatch = live.watch(ref.businessId, ref.collection, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), RELOAD_DEBOUNCE_MS);
    });
    void load();
    onCleanup(() => {
      stopped = true;
      clearTimeout(timer);
      unwatch();
    });
  });
  return { data, loading, error };
}
