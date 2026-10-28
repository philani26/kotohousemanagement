import { Injectable, computed, inject, signal } from '@angular/core';
import {
  User,
  createUserWithEmailAndPassword,
  onIdTokenChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { Role, UserClaims, claimMemberships } from '@shared/models';
import { environment } from '../../environments/environment';
import { FirebaseService } from './firebase.service';

interface Session {
  user: User;
  /** every shop this login belongs to → role there */
  memberships: Record<string, Role>;
  /** default shop from the claims (legacy single-shop accounts) */
  defaultBusinessId: string | null;
}

const shopKey = (uid: string) => `kotahouse.shop.${uid}`;

/**
 * Exposes the signed-in user and their role. Roles come from custom claims
 * set by Cloud Functions, so they cannot be changed from the browser.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly fb = inject(FirebaseService);
  /** undefined while Firebase restores the session */
  readonly session = signal<Session | null | undefined>(undefined);
  /** set when the saved session could not be restored because the sign-in service was unreachable */
  readonly connectionError = signal<string | null>(null);

  readonly user = computed(() => this.session()?.user ?? null);
  readonly uid = computed(() => this.session()?.user.uid ?? '');
  readonly memberships = computed(() => this.session()?.memberships ?? {});
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
  readonly displayName = computed(() => this.user()?.displayName || this.user()?.email || '');

  readonly ready: Promise<void>;

  constructor() {
    this.ready = new Promise((resolve) => {
      onIdTokenChanged(this.fb.auth, async (user) => {
        try {
          if (!user) {
            this.session.set(null);
          } else {
            // Refreshes an expired token over the network – this fails if the
            // sign-in service (or the local emulator) cannot be reached.
            const token = await user.getIdTokenResult();
            const claims = token.claims as unknown as Partial<UserClaims>;
            this.chosen.set(readChosen(user.uid));
            this.session.set({
              user,
              memberships: claimMemberships(claims),
              defaultBusinessId: claims.businessId ?? null,
            });
          }
          this.connectionError.set(null);
        } catch (err) {
          // Never leave the app waiting forever (a blank screen): show the sign-in page with the reason.
          console.error('Could not restore the session', err);
          this.session.set(null);
          this.connectionError.set(
            environment.useEmulators
              ? 'Cannot reach the local sign-in emulator. Start it with "npm run emulators", then refresh.'
              : 'Cannot reach the sign-in service. Check the internet connection, then refresh.',
          );
        } finally {
          resolve();
        }
      });
      // Safety net: if sign-in never answers (e.g. a hanging network), stop waiting after 10 s.
      setTimeout(() => {
        if (this.session() !== undefined) return;
        this.session.set(null);
        this.connectionError.set(
          environment.useEmulators
            ? 'The local sign-in emulator is not answering. Start it with "npm run emulators", then refresh.'
            : 'The sign-in service is not answering. Check the internet connection, then refresh.',
        );
        resolve();
      }, 10_000);
    });
  }

  /**
   * Switches this device to another shop. A full reload clears every live
   * listener and cached screen from the previous shop.
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

  signIn(email: string, password: string) {
    return signInWithEmailAndPassword(this.fb.auth, email.trim(), password);
  }

  async signUpOwner(email: string, password: string, displayName: string) {
    const cred = await createUserWithEmailAndPassword(this.fb.auth, email.trim(), password);
    await updateProfile(cred.user, { displayName });
    return cred;
  }

  resetPassword(email: string) {
    return sendPasswordResetEmail(this.fb.auth, email.trim());
  }

  /** Forces a token refresh after the backend changes this user's claims. */
  async refreshClaims() {
    const user = this.fb.auth.currentUser;
    if (!user) return;
    // Apply the new claims here rather than waiting for the async token listener,
    // so callers (e.g. switching to a just-created shop) see them immediately.
    const token = await user.getIdTokenResult(true);
    const claims = token.claims as unknown as Partial<UserClaims>;
    this.session.set({ user, memberships: claimMemberships(claims), defaultBusinessId: claims.businessId ?? null });
  }

  signOut() {
    return signOut(this.fb.auth);
  }
}

function readChosen(uid: string): string | null {
  try {
    return localStorage.getItem(shopKey(uid));
  } catch {
    return null;
  }
}
