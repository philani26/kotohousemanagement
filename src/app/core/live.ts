import { Signal, effect, signal, untracked } from '@angular/core';
import { DocumentReference, Query, onSnapshot } from 'firebase/firestore';

export interface Live<T> {
  data: Signal<T>;
  loading: Signal<boolean>;
  error: Signal<string | null>;
}

/**
 * Subscribes to a Firestore query as a signal. The query factory may read
 * other signals (filters); the listener is re-created when they change and
 * removed when the component is destroyed. Must run in an injection context.
 */
export function liveQuery<T>(factory: () => Query | null): Live<T[]> {
  const data = signal<T[]>([]);
  const loading = signal(true);
  const error = signal<string | null>(null);
  effect((onCleanup) => {
    const q = factory();
    untracked(() => loading.set(true));
    if (!q) {
      untracked(() => {
        data.set([]);
        loading.set(false);
      });
      return;
    }
    const unsub = onSnapshot(
      q,
      (snap) => {
        data.set(snap.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as T));
        loading.set(false);
        error.set(null);
      },
      (err) => {
        console.error(err);
        error.set(err.code === 'permission-denied' ? 'You do not have access to this information' : err.message);
        loading.set(false);
      },
    );
    onCleanup(unsub);
  });
  return { data, loading, error };
}

export function liveDoc<T>(factory: () => DocumentReference | null): Live<T | null> {
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
    const unsub = onSnapshot(
      ref,
      (snap) => {
        data.set(snap.exists() ? ({ ...(snap.data() as object), id: snap.id } as T) : null);
        loading.set(false);
      },
      (err) => {
        error.set(err.message);
        loading.set(false);
      },
    );
    onCleanup(unsub);
  });
  return { data, loading, error };
}
