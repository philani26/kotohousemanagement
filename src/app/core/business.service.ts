import { Injectable, computed, inject } from '@angular/core';
import { CollectionReference, collection, doc, limit, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { DEFAULT_SETTINGS, BusinessSettings, COLLECTIONS, SETTINGS_DOC_ID, Shift } from '@shared/models';
import { dayKey } from '@shared/domain';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';
import { liveDoc, liveQuery } from './live';

type BizCollection = Exclude<keyof typeof COLLECTIONS, 'users' | 'businesses'>;

/** Business-scoped Firestore paths plus app-wide live state (settings, open shift). */
@Injectable({ providedIn: 'root' })
export class BusinessService {
  private readonly fb = inject(FirebaseService);
  private readonly auth = inject(AuthService);

  private readonly settingsDoc = liveDoc<BusinessSettings>(() => {
    const b = this.auth.businessId();
    return b ? doc(this.fb.db, COLLECTIONS.businesses, b, COLLECTIONS.businessSettings, SETTINGS_DOC_ID) : null;
  });

  readonly settings = computed<BusinessSettings>(() => {
    const s = this.settingsDoc.data();
    return {
      ...DEFAULT_SETTINGS,
      ...(s ?? {}),
      thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(s?.thresholds ?? {}) },
      notifications: { ...DEFAULT_SETTINGS.notifications, ...(s?.notifications ?? {}) },
      cctv: { ...DEFAULT_SETTINGS.cctv, ...(s?.cctv ?? {}) },
    };
  });

  /** The shop runs a single till, so there is at most one open shift. */
  private readonly openShifts = liveQuery<Shift>(() =>
    this.auth.businessId() ? query(this.col('shifts'), where('status', '==', 'open'), limit(1)) : null,
  );
  readonly openShift = computed(() => this.openShifts.data()[0] ?? null);
  readonly openShiftLoading = this.openShifts.loading;
  readonly myOpenShift = computed(() => {
    const s = this.openShift();
    return s && (s.employeeId === this.auth.uid() || this.auth.isOwner()) ? s : null;
  });

  col(name: BizCollection): CollectionReference {
    return collection(this.fb.db, COLLECTIONS.businesses, this.requireBusiness(), COLLECTIONS[name]);
  }

  docRef(name: BizCollection, id: string) {
    return doc(this.col(name), id);
  }

  today(): string {
    return dayKey(new Date(), this.settings().timezone);
  }

  /** Owner catalogue writes must carry these stamps (enforced by security rules). */
  stamp() {
    return { updatedBy: this.auth.uid(), updatedAt: serverTimestamp() };
  }

  saveSettings(changes: Partial<BusinessSettings>) {
    return updateDoc(this.docRef('businessSettings', SETTINGS_DOC_ID), { ...changes, ...this.stamp() });
  }

  private requireBusiness(): string {
    const b = this.auth.businessId();
    if (!b) throw new Error('Not linked to a business');
    return b;
  }
}
