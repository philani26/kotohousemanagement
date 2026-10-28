import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BusinessSettings } from '@shared/models';
import { centsToRandString, parseRandToCents } from '@shared/money';
import { BusinessService } from '../../core/business.service';
import { ToastService } from '../../core/toast.service';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface Form {
  businessName: string;
  openingHour: number;
  closingHour: number;
  tradingDays: number[];
  maxEmployeeDiscountPercent: number;
  cashDiscrepancy: string;
  refundAlert: string;
  discountAlertPercent: number;
  wastageAlert: string;
  stockVarianceAlert: string;
  noSaleMinutes: number;
  missingCloseGraceMinutes: number;
  expenseCategories: string;
  openingChecklist: string;
  closingChecklist: string;
  email: boolean;
  emailTo: string;
  cctvProvider: string;
  cctvViewerUrl: string;
  cctvAndroid: string;
  cctvIos: string;
  cctvNotes: string;
}

function toForm(s: BusinessSettings): Form {
  const r = centsToRandString;
  return {
    businessName: s.businessName,
    openingHour: s.openingHour,
    closingHour: s.closingHour,
    tradingDays: [...s.tradingDays],
    maxEmployeeDiscountPercent: s.maxEmployeeDiscountPercent,
    cashDiscrepancy: r(s.thresholds.cashDiscrepancyCents),
    refundAlert: r(s.thresholds.refundAlertCents),
    discountAlertPercent: s.thresholds.discountAlertPercent,
    wastageAlert: r(s.thresholds.wastageAlertCents),
    stockVarianceAlert: r(s.thresholds.stockVarianceAlertCents),
    noSaleMinutes: s.thresholds.noSaleMinutes,
    missingCloseGraceMinutes: s.thresholds.missingCloseGraceMinutes,
    expenseCategories: s.expenseCategories.join('\n'),
    openingChecklist: s.openingChecklist.join('\n'),
    closingChecklist: s.closingChecklist.join('\n'),
    email: s.notifications.email,
    emailTo: s.notifications.emailTo.join(', '),
    cctvProvider: s.cctv.provider,
    cctvViewerUrl: s.cctv.viewerUrl,
    cctvAndroid: s.cctv.androidAppUrl,
    cctvIos: s.cctv.iosAppUrl,
    cctvNotes: s.cctv.notes,
  };
}

const lines = (t: string) => t.split('\n').map((x) => x.trim()).filter(Boolean);

@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  template: `
    <div class="page-head"><h1>Settings</h1></div>
    @if (form(); as f) {
      <form (ngSubmit)="save()">
        <div class="grid-2">
          <div class="card">
            <h2>Shop</h2>
            <label class="field"><span>Shop name</span><input name="bn" [(ngModel)]="f.businessName" /></label>
            <div class="form-grid">
              <label class="field"><span>Opens (hour, 0–23)</span><input name="oh" type="number" min="0" max="23" [(ngModel)]="f.openingHour" /></label>
              <label class="field"><span>Closes (hour, 0–23)</span><input name="ch" type="number" min="1" max="24" [(ngModel)]="f.closingHour" /></label>
            </div>
            <span class="small muted">Trading days</span>
            <div class="row" style="margin: .35rem 0 1rem">
              @for (d of days; track $index; let i = $index) {
                <label class="check" style="padding: 0 .4rem 0 0"><input type="checkbox" [checked]="f.tradingDays.includes(i)" (change)="toggleDay(f, i)" />{{ d }}</label>
              }
            </div>
            <label class="field">
              <span>Max discount a cashier may give without you (%) <span class="hint">– 0 means only you can discount</span></span>
              <input name="md" type="number" min="0" max="100" [(ngModel)]="f.maxEmployeeDiscountPercent" />
            </label>
          </div>

          <div class="card">
            <h2>Alert thresholds</h2>
            <div class="form-grid">
              <label class="field"><span>Cash difference over (R)</span><input name="t1" inputmode="decimal" [(ngModel)]="f.cashDiscrepancy" /></label>
              <label class="field"><span>Refund over (R) is critical</span><input name="t2" inputmode="decimal" [(ngModel)]="f.refundAlert" /></label>
              <label class="field"><span>Discount from (%)</span><input name="t3" type="number" [(ngModel)]="f.discountAlertPercent" /></label>
              <label class="field"><span>Daily wastage over (R)</span><input name="t4" inputmode="decimal" [(ngModel)]="f.wastageAlert" /></label>
              <label class="field"><span>Stock count variance over (R)</span><input name="t5" inputmode="decimal" [(ngModel)]="f.stockVarianceAlert" /></label>
              <label class="field"><span>No sales for (minutes)</span><input name="t6" type="number" min="30" [(ngModel)]="f.noSaleMinutes" /></label>
              <label class="field"><span>Missing close after (minutes past closing)</span><input name="t7" type="number" min="15" [(ngModel)]="f.missingCloseGraceMinutes" /></label>
            </div>
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <h2>Lists</h2>
            <label class="field"><span>Expense categories <span class="hint">– one per line</span></span><textarea name="ec" rows="6" [(ngModel)]="f.expenseCategories"></textarea></label>
            <label class="field"><span>Opening checklist</span><textarea name="oc" rows="4" [(ngModel)]="f.openingChecklist"></textarea></label>
            <label class="field"><span>Closing checklist</span><textarea name="cc" rows="5" [(ngModel)]="f.closingChecklist"></textarea></label>
          </div>

          <div class="card">
            <h2>Notifications</h2>
            <p class="small muted">Alerts always appear in the app. Email uses the Firebase “Trigger Email” extension (see docs/NOTIFICATIONS.md).</p>
            <label class="check"><input type="checkbox" name="em" [(ngModel)]="f.email" /> Also email warning & critical alerts</label>
            <label class="field"><span>Email to <span class="hint">– comma separated</span></span><input name="et" [(ngModel)]="f.emailTo" /></label>
            <p class="tiny">WhatsApp alerts need an approved WhatsApp Business API provider and are not switched on yet.</p>

            <div class="divider"></div>
            <h2>CCTV</h2>
            <label class="field"><span>System / brand</span><input name="cp" [(ngModel)]="f.cctvProvider" placeholder="e.g. Hikvision, Dahua, Ezviz" /></label>
            <label class="field"><span>Secure web viewer link (https)</span><input name="cv" type="url" [(ngModel)]="f.cctvViewerUrl" /></label>
            <label class="field"><span>Android app link</span><input name="ca" type="url" [(ngModel)]="f.cctvAndroid" /></label>
            <label class="field"><span>iPhone app link</span><input name="ci" type="url" [(ngModel)]="f.cctvIos" /></label>
            <label class="field"><span>Notes (camera names, which app to use – no passwords)</span><textarea name="cn" [(ngModel)]="f.cctvNotes"></textarea></label>
          </div>
        </div>

        <button class="btn primary xl block" [disabled]="busy()">Save settings</button>
      </form>
    }
  `,
})
export class SettingsPage {
  private readonly biz = inject(BusinessService);
  private readonly toast = inject(ToastService);
  protected readonly days = DAYS;
  protected readonly busy = signal(false);
  protected readonly form = signal<Form | null>(null);

  constructor() {
    // Load once settings arrive; do not overwrite edits on later snapshots.
    effect(() => {
      const s = this.biz.settings();
      if (untracked(() => this.form()) === null && s.updatedAt) this.form.set(toForm(s));
    });
  }

  toggleDay(f: Form, i: number) {
    f.tradingDays = f.tradingDays.includes(i) ? f.tradingDays.filter((d) => d !== i) : [...f.tradingDays, i].sort();
  }

  async save() {
    const f = this.form();
    if (!f) return;
    const money = (t: string, label: string) => {
      const c = parseRandToCents(t);
      if (c === null) throw new Error(`${label} is not a valid amount`);
      return c;
    };
    const https = (u: string) => (u && !/^https:\/\//i.test(u) ? (() => { throw new Error('CCTV links must start with https://'); })() : u.trim());
    this.busy.set(true);
    try {
      const categories = lines(f.expenseCategories);
      if (!categories.length) throw new Error('Add at least one expense category');
      await this.biz.saveSettings({
        businessName: f.businessName.trim() || 'Kota House',
        openingHour: clamp(f.openingHour, 0, 23),
        closingHour: clamp(f.closingHour, 1, 24),
        tradingDays: f.tradingDays,
        maxEmployeeDiscountPercent: clamp(f.maxEmployeeDiscountPercent, 0, 100),
        thresholds: {
          cashDiscrepancyCents: money(f.cashDiscrepancy, 'Cash difference'),
          refundAlertCents: money(f.refundAlert, 'Refund alert'),
          discountAlertPercent: clamp(f.discountAlertPercent, 0, 100),
          wastageAlertCents: money(f.wastageAlert, 'Wastage alert'),
          stockVarianceAlertCents: money(f.stockVarianceAlert, 'Stock variance alert'),
          noSaleMinutes: clamp(f.noSaleMinutes, 30, 1440),
          missingCloseGraceMinutes: clamp(f.missingCloseGraceMinutes, 15, 600),
        },
        expenseCategories: categories,
        openingChecklist: lines(f.openingChecklist),
        closingChecklist: lines(f.closingChecklist),
        notifications: {
          email: f.email,
          emailTo: f.emailTo.split(',').map((e) => e.trim()).filter(Boolean),
          whatsapp: false,
          whatsappTo: [],
        },
        cctv: {
          provider: f.cctvProvider.trim(),
          viewerUrl: https(f.cctvViewerUrl),
          androidAppUrl: https(f.cctvAndroid),
          iosAppUrl: https(f.cctvIos),
          notes: f.cctvNotes.trim(),
        },
      });
      this.toast.ok('Settings saved');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(Number(n) || 0)));
}
