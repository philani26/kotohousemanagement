import { Injectable, inject } from '@angular/core';
import { httpsCallable } from 'firebase/functions';
import { ApiName, ApiRequest, ApiResponse } from '@shared/api';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';

/** Error from a callable, keeping whether it was a network problem (safe to queue/retry). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly network: boolean,
  ) {
    super(message);
  }
}

/** Typed wrapper around the trusted Cloud Functions. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly fb = inject(FirebaseService);
  private readonly auth = inject(AuthService);

  async call<K extends ApiName>(name: K, data: ApiRequest<K>): Promise<ApiResponse<K>> {
    // 20 s instead of the SDK's 70 s: a waiting customer needs a quick answer, and retries are idempotent.
    const fn = httpsCallable<ApiRequest<K>, ApiResponse<K>>(this.fb.functions, name, { timeout: 20_000 });
    try {
      // Tell the backend which shop this device is working in; it checks membership.
      // A businessId already in the data (queued offline sales) wins.
      const businessId = this.auth.businessId();
      return (await fn(businessId ? { businessId, ...data } : data)).data;
    } catch (err) {
      const e = err as { code?: string };
      throw new ApiError(friendlyError(err), e?.code ?? 'unknown', isNetworkError(err));
    }
  }
}

/**
 * The SDK reports a failed fetch as `internal` with the bare message "internal";
 * real server errors from our functions always carry a readable message.
 */
export function isNetworkError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return (
    e?.code === 'functions/unavailable' ||
    e?.code === 'functions/deadline-exceeded' ||
    (e?.code === 'functions/internal' && e.message === 'internal')
  );
}

export function friendlyError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (isNetworkError(err)) {
    return environment.useEmulators
      ? 'Cannot reach the local Cloud Functions emulator – nothing was saved. Is `npm run emulators` running?'
      : 'Cannot reach the server – nothing was saved. Check the network and try again.';
  }
  return e?.message || 'Something went wrong';
}
