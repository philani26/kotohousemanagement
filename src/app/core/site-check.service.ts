import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { doc } from 'firebase/firestore';
import { COLLECTIONS, Employee } from '@shared/models';
import { ApiResponse } from '@shared/api';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { BusinessService } from './business.service';
import { FirebaseService } from './firebase.service';
import { liveDoc } from './live';

export type SiteState = 'not-needed' | 'loading' | 'ok' | 'required';

/**
 * Work-site check (geofence). When the owner turned it on, cashiers and
 * kitchen staff must check in from the shop before they can work; the
 * server enforces the same rule. Owners are never blocked.
 */
@Injectable({ providedIn: 'root' })
export class SiteCheckService {
  private readonly auth = inject(AuthService);
  private readonly biz = inject(BusinessService);
  private readonly fb = inject(FirebaseService);
  private readonly api = inject(ApiService);
  /** re-evaluated every minute so an expired check-in is noticed */
  private readonly now = signal(Date.now());

  private readonly me = liveDoc<Employee>(() => {
    const b = this.auth.businessId();
    const uid = this.auth.uid();
    return b && uid && !this.auth.isOwner() ? doc(this.fb.db, COLLECTIONS.businesses, b, COLLECTIONS.employees, uid) : null;
  });

  readonly state = computed<SiteState>(() => {
    if (this.auth.isOwner() || !this.biz.settings().geofence.enabled) return 'not-needed';
    if (this.me.loading()) return 'loading';
    const until = this.me.data()?.siteCheckUntil?.toMillis() ?? 0;
    return until > this.now() ? 'ok' : 'required';
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** Reads the phone's location once and asks the server to check it. */
  async checkIn(): Promise<ApiResponse<'checkIn'>> {
    const pos = await currentPosition();
    const res = await this.api.call('checkIn', { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy });
    this.now.set(Date.now());
    return res;
  }
}

export function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This phone or browser cannot share its location'));
    navigator.geolocation.getCurrentPosition(resolve, (err) => reject(new Error(locationError(err))), {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 0,
    });
  });
}

function locationError(err: GeolocationPositionError): string {
  if (err.code === err.PERMISSION_DENIED) return 'Location is blocked for this app. Allow location in your browser settings, then try again.';
  if (err.code === err.TIMEOUT) return 'Finding your location took too long. Turn on GPS / Location and try again.';
  return 'Your location is not available. Turn on GPS / Location and try again.';
}
