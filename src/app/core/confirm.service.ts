import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** label/value rows shown as a summary, e.g. a cash-up */
  details?: { label: string; value: string; strong?: boolean }[];
  /** extra line under the summary, e.g. "This cannot be changed" */
  warning?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'primary' | 'danger' | 'dark';
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/** In-app replacement for window.confirm(), rendered by ConfirmDialogComponent. */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly current = signal<Pending | null>(null);

  ask(options: ConfirmOptions): Promise<boolean> {
    this.current()?.resolve(false);
    return new Promise((resolve) => this.current.set({ ...options, resolve }));
  }

  answer(ok: boolean) {
    const c = this.current();
    this.current.set(null);
    c?.resolve(ok);
  }
}
