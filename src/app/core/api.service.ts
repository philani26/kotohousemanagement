import { Injectable, inject } from '@angular/core';
import { ApiName, ApiRequest, ApiResponse } from '@shared/api';
import { environment } from '../../environments/environment';
import { AuthService, NetworkError } from './auth.service';
import { deviceId } from './device-id';

/** Error from an action, keeping whether it was a network problem (safe to queue/retry). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly network: boolean,
  ) {
    super(message);
  }
}

/** A waiting customer needs a quick answer, and retries are safe. */
const TIMEOUT_MS = 20_000;

/** Typed calls to the server actions of the Java backend (same names and data as the old Cloud Functions). */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly auth = inject(AuthService);

  async call<K extends ApiName>(name: K, data: ApiRequest<K>): Promise<ApiResponse<K>> {
    // Tell the backend which shop this device is working in; it checks membership.
    // A businessId already in the data (queued offline sales) wins.
    // Also send this device's id: when the owner locks work to approved devices, the server checks it.
    const businessId = (data as { businessId?: string }).businessId ?? this.auth.businessId();
    const body: Record<string, unknown> = { deviceId: deviceId(), ...(businessId ? { businessId } : {}), ...(data as object) };
    let path = `/api/rpc/${name}`;
    let method = 'POST';
    // logins, shops and staff have their own resources
    if (name === 'setupBusiness') path = '/api/businesses';
    else if (name === 'createEmployee') path = `/api/businesses/${businessId}/staff`;
    else if (name === 'updateEmployee') {
      path = `/api/businesses/${businessId}/staff/${encodeURIComponent(String((data as { uid: string }).uid))}`;
      method = 'PATCH';
    }
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.auth.fetch(path, { method, body: JSON.stringify(body), signal: control.signal });
    } catch (err) {
      if (err instanceof NetworkError || (err as Error).name === 'AbortError') {
        throw new ApiError(friendlyError(err), 'unavailable', true);
      }
      throw new ApiError((err as Error).message || 'Something went wrong', (err as { code?: string }).code ?? 'unknown', false);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      // the server is overloaded or restarting: like no network, safe to retry
      const network = res.status >= 502 && res.status <= 504;
      throw new ApiError(network ? friendlyError(new NetworkError('')) : String(json['message'] ?? 'Something went wrong'), String(json['code'] ?? res.status), network);
    }
    return json as ApiResponse<K>;
  }
}

export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return err instanceof NetworkError || (err as Error)?.name === 'AbortError' || (err instanceof ApiError && err.network);
}

export function friendlyError(err: unknown): string {
  const e = err as { message?: string };
  if (isNetworkError(err)) {
    return environment.name === 'local'
      ? 'Cannot reach the local backend – nothing was saved. Is `docker compose --profile app up` running in backend/?'
      : 'Cannot reach the server – nothing was saved. Check the network and try again.';
  }
  return e?.message || 'Something went wrong';
}
