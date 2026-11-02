import { Injectable, computed, signal } from '@angular/core';
import { Role } from '@shared/models';
import { environment } from '../../environments/environment';

export interface SessionUser {
  uid: string;
  email: string;
  displayName: string;
}

interface Session {
  user: SessionUser;
  /** every shop this login belongs to → role there */
  memberships: Record<string, Role>;
  /** shop names, for the shop switcher */
  shopNames: Record<string, string>;
  /** the first shop (used when this device hasn't chosen one) */
  defaultBusinessId: string | null;
}

interface ServerSession {
  accessToken: string | null;
  refreshToken: string | null;
  expiresIn: number;
  user: SessionUser;
  memberships: { businessId: string; businessName: string; role: Role }[];
}

const shopKey = (uid: string) => `kotahouse.shop.${uid}`;
const REFRESH_KEY = 'kotahouse.refreshToken';
/** renew the access token this long before it expires */
const EARLY_MS = 60_000;

/** A fetch failed before reaching the server (no internet, server down). */
export class NetworkError extends Error {
  readonly code = 'network';
}

/**
 * The signed-in person and their role in the current shop. Signing in goes
 * to the Java backend: a short-lived access token is kept in memory only, and
 * a refresh token on this device so staff stay signed in. Roles come from the
 * server (and are checked there on every request), never from the browser.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  /** undefined while the saved session is being restored */
  readonly session = signal<Session | null | undefined>(undefined);
  /** set when the saved session could not be restored because the server was unreachable */
  readonly connectionError = signal<string | null>(null);

  readonly user = computed(() => this.session()?.user ?? null);
  readonly uid = computed(() => this.session()?.user.uid ?? '');
  readonly memberships = computed(() => this.session()?.memberships ?? {});
  readonly shopNames = computed(() => this.session()?.shopNames ?? {});
  /** shop chosen on this device (each phone remembers its own) */
  private readonly chosen = signal<string | null>(null);
  readonly businessId = computed(() => {
    const s = this.session();
    if (!s) return null;
    const chosen = this.chosen();
    if (chosen && s.memberships[chosen]) return chosen;
    if (s.defaultBusinessId && s.memberships[s.defaultBusinessId]) return s.defaultBusinessId;
    return Object.keys(s.memberships)[0] ?? null;
  });
  readonly role = computed<Role | null>(() => {
    const b = this.businessId();
    return b ? (this.memberships()[b] ?? null) : null;
  });
  /** true if this login owns at least one shop (may add more shops) */
  readonly ownsAShop = computed(() => Object.values(this.memberships()).includes('owner'));
  readonly isOwner = computed(() => this.role() === 'owner');
  /** kitchen staff only use the order queue */
  readonly isKitchen = computed(() => this.role() === 'kitchen');
  readonly displayName = computed(() => this.user()?.displayName || this.user()?.email || '');

  readonly ready: Promise<void>;

  private accessToken: string | null = null;
  private expiresAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor() {
    this.ready = this.restore();
  }

  private async restore(): Promise<void> {
    if (!readRefresh()) {
      this.session.set(null);
      return;
    }
    try {
      await this.renew();
      this.connectionError.set(null);
    } catch (err) {
      this.session.set(null);
      if (err instanceof NetworkError) {
        // keep the refresh token: the next attempt (refresh the page) can still use it
        this.connectionError.set(
          environment.name === 'local'
            ? 'Cannot reach the local backend. Start it with "docker compose --profile app up" in backend/, then refresh.'
            : 'Cannot reach the server. Check the internet connection, then refresh.',
        );
      }
    }
  }

  /** Swaps the refresh token for a new pair (single flight). Signs out if the server refuses it. */
  private renew(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const res = await raw('/api/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: readRefresh() }) });
        if (!res.ok) {
          this.clear();
          throw Object.assign(new Error('Please sign in again'), { code: 'unauthenticated' });
        }
        this.apply((await res.json()) as ServerSession);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private apply(s: ServerSession) {
    if (s.accessToken) {
      this.accessToken = s.accessToken;
      this.expiresAt = Date.now() + s.expiresIn * 1000;
    }
    if (s.refreshToken) writeRefresh(s.refreshToken);
    const memberships: Record<string, Role> = {};
    const shopNames: Record<string, string> = {};
    for (const m of s.memberships) {
      memberships[m.businessId] = m.role;
      shopNames[m.businessId] = m.businessName;
    }
    this.chosen.set(readChosen(s.user.uid));
    this.session.set({ user: s.user, memberships, shopNames, defaultBusinessId: s.memberships[0]?.businessId ?? null });
  }

  private clear() {
    this.accessToken = null;
    this.expiresAt = 0;
    writeRefresh(null);
    this.session.set(null);
  }

  /** A valid access token, renewed when about to expire. */
  async token(): Promise<string> {
    if (!this.accessToken || Date.now() > this.expiresAt - EARLY_MS) await this.renew();
    return this.accessToken!;
  }

  /** fetch() to the backend with the access token; renews and retries once if it had just expired. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const send = async () =>
      raw(path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await this.token()}` } });
    let res = await send();
    if (res.status === 401 && readRefresh()) {
      this.accessToken = null;
      res = await send();
    }
    return res;
  }

  /**
   * Switches this device to another shop. A full reload clears every live
   * list and cached screen from the previous shop.
   */
  switchShop(businessId: string, goTo = '/') {
    if (!this.memberships()[businessId]) throw new Error('You are not a member of that shop');
    try {
      localStorage.setItem(shopKey(this.uid()), businessId);
    } catch {
      // private mode: the switch still applies until the page reloads
    }
    this.chosen.set(businessId);
    window.location.assign(goTo);
  }

  async signIn(email: string, password: string) {
    const res = await raw('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: email.trim(), password }) });
    if (!res.ok) throw await errorOf(res);
    this.apply((await res.json()) as ServerSession);
    this.connectionError.set(null);
  }

  async signUpOwner(email: string, password: string, displayName: string) {
    const res = await raw('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: email.trim(), password, displayName }) });
    if (!res.ok) throw await errorOf(res);
    this.apply((await res.json()) as ServerSession);
  }

  async resetPassword(email: string) {
    const res = await raw('/api/auth/password-reset', { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
    if (!res.ok) throw await errorOf(res);
  }

  async confirmPasswordReset(token: string, newPassword: string) {
    const res = await raw('/api/auth/password-reset/confirm', { method: 'POST', body: JSON.stringify({ token, newPassword }) });
    if (!res.ok) throw await errorOf(res);
  }

  /** Reloads this person's shops and roles after the server changed them (e.g. a new shop). */
  async refreshClaims() {
    const res = await this.fetch('/api/me');
    if (!res.ok) throw await errorOf(res);
    this.apply((await res.json()) as ServerSession);
  }

  async signOut() {
    const refreshToken = readRefresh();
    this.clear();
    if (refreshToken) await raw('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }).catch(() => undefined);
  }
}

/** fetch() to the backend; network failures become NetworkError. */
async function raw(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(environment.apiUrl + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError('Cannot reach the server');
  }
}

async function errorOf(res: Response): Promise<Error & { code?: string }> {
  try {
    const body = (await res.json()) as { code?: string; message?: string };
    return Object.assign(new Error(body.message ?? 'Sign in failed'), { code: body.code });
  } catch {
    return Object.assign(new Error(`Error ${res.status}`), { code: String(res.status) });
  }
}

function readChosen(uid: string): string | null {
  try {
    return localStorage.getItem(shopKey(uid));
  } catch {
    return null;
  }
}

function readRefresh(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function writeRefresh(token: string | null) {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    // storage blocked: the session lasts until the page closes
  }
}
