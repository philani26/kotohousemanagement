import { Injectable, computed, inject } from '@angular/core';
import { CollectionReference, DocumentReference, collectionRef, doc, limit, query, where } from './db';
import { DEFAULT_SETTINGS, BusinessSettings, COLLECTIONS, SETTINGS_DOC_ID, Shift } from '@shared/models';
import { dayKey } from '@shared/domain';
import { cleanLoyalty } from '@shared/loyalty';
import { AuthService } from './auth.service';
import { ApiService } from './api.service';
import { LiveService } from './live.service';
import { liveDoc, liveQuery } from './live';

type BizCollection = Exclude<keyof typeof COLLECTIONS, 'users' | 'businesses'>;

/** The current shop's records plus app-wide live state (settings, open shift). */
@Injectable({ providedIn: 'root' })
export class BusinessService {
  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  private readonly auth = inject(AuthService);

  private readonly settingsDoc = liveDoc<BusinessSettings>(() => {
    const b = this.auth.businessId();
    return b ? doc(collectionRef(b, COLLECTIONS.businessSettings), SETTINGS_DOC_ID) : null;
  });

  readonly settings = computed<BusinessSettings>(() => {
    const s = this.settingsDoc.data();
    return {
      ...DEFAULT_SETTINGS,
      ...(s ?? {}),
      thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(s?.thresholds ?? {}) },
      notifications: { ...DEFAULT_SETTINGS.notifications, ...(s?.notifications ?? {}) },
      cctv: { ...DEFAULT_SETTINGS.cctv, ...(s?.cctv ?? {}) },
      whatsapp: { ...DEFAULT_SETTINGS.whatsapp, ...(s?.whatsapp ?? {}) },
      geofence: { ...DEFAULT_SETTINGS.geofence, ...(s?.geofence ?? {}) },
      devices: { ...DEFAULT_SETTINGS.devices, ...(s?.devices ?? {}) },
      loyalty: cleanLoyalty(s?.loyalty),
      yoco: { ...DEFAULT_SETTINGS.yoco, ...(s?.yoco ?? {}) },
    };
  });

  /** The shop runs a single till, so there is at most one open shift. */
  private readonly openShifts = liveQuery<Shift>(() =>
    // the kitchen has no access to shifts
    this.auth.businessId() && !this.auth.isKitchen() ? query(this.col('shifts'), where('status', '==', 'open'), limit(1)) : null,
  );
  readonly openShift = computed(() => this.openShifts.data()[0] ?? null);
  readonly openShiftLoading = this.openShifts.loading;
  readonly myOpenShift = computed(() => {
    const s = this.openShift();
    return s && (s.employeeId === this.auth.uid() || this.auth.isOwner()) ? s : null;
  });

  col(name: BizCollection): CollectionReference {
    return collectionRef(this.requireBusiness(), COLLECTIONS[name]);
  }

  docRef(name: BizCollection, id: string): DocumentReference {
    return doc(this.col(name), id);
  }

  /** Reads one record once (null if it doesn't exist). */
  get<T>(ref: DocumentReference): Promise<T | null> {
    return this.live.get<T>(ref);
  }

  today(): string {
    return dayKey(new Date(), this.settings().timezone);
  }

  /** Owner: merges changes into the shop's settings (checked and stamped on the server). */
  saveSettings(changes: Partial<BusinessSettings>) {
    return this.api.call('saveCatalog', { writes: [{ collection: 'businessSettings', data: changes as Record<string, unknown> }] });
  }

  private requireBusiness(): string {
    const b = this.auth.businessId();
    if (!b) throw new Error('Not linked to a business');
    return b;
  }
}
