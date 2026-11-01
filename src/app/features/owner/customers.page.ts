import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { orderBy, query } from 'firebase/firestore';
import { Customer, rewardReady } from '@shared/loyalty';
import { centsToRandString, parseRandToCents } from '@shared/money';
import { displayPhone } from '@shared/whatsapp';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { ZarPipe } from '../../shared/pipes';

/** Owner: regular customers (saved by cellphone at the till) and the stamp card. */
@Component({
  selector: 'app-customers',
  imports: [FormsModule, DatePipe, ZarPipe],
  template: `
    <div class="page-head"><h1>⭐ Customers</h1></div>

    <form class="card" (ngSubmit)="save()">
      <div class="card-head">
        <h2>Stamp card</h2>
        <span class="badge" [class.ok]="biz.settings().loyalty.enabled">{{ biz.settings().loyalty.enabled ? 'On' : 'Off' }}</span>
      </div>
      <label class="check"><input type="checkbox" name="on" [(ngModel)]="enabled" /> Give customers a stamp card</label>
      <div class="row" style="gap: .75rem; margin-top: .5rem; align-items: flex-end">
        <label class="field" style="max-width: 160px; margin: 0"><span>Stamps for a reward</span>
          <input type="number" name="need" min="1" max="50" [(ngModel)]="stampsNeeded" /></label>
        <label class="field" style="max-width: 180px; margin: 0"><span>Spend for 1 stamp (R)</span>
          <input inputmode="decimal" name="min" [(ngModel)]="minSpend" /></label>
        <label class="field" style="max-width: 180px; margin: 0"><span>Reward: up to (R) off</span>
          <input inputmode="decimal" name="reward" [(ngModel)]="rewardValue" /></label>
        <button class="btn primary" [disabled]="busy()">Save</button>
      </div>
      <p class="tiny" style="margin-top: .75rem">
        Example: 9 stamps, R30 for a stamp, reward up to R40 off = "buy 9 kotas, the 10th is free". The cashier adds the customer's cellphone
        number to a sale (＋ Customer) and ticks <em>Use free reward</em> when the card is full. The server checks the stamps, so rewards can't be faked.
        Rewards show as discounts in reports. Tell customers their number is kept for the stamp card (POPIA).
      </p>
    </form>

    <div class="card">
      <div class="card-head">
        <h2>Customers ({{ customers.data().length }})</h2>
        <div class="row" style="gap: .35rem; flex-wrap: nowrap">
          <input type="search" placeholder="Search name or number" [ngModel]="search()" (ngModelChange)="search.set($event)" name="q" style="max-width: 220px" />
          <button class="btn small" (click)="downloadCsv()">⬇ CSV</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Customer</th><th>Visits</th><th>Spent</th><th>Stamps</th><th>Rewards used</th><th>Last visit</th></tr></thead>
          <tbody>
            @for (c of visible(); track c.phone) {
              <tr>
                <td><strong>{{ c.name || '–' }}</strong><div class="tiny">{{ phone(c.phone) }}</div></td>
                <td>{{ c.visits }}</td>
                <td>{{ c.spentCents | zar }}</td>
                <td>
                  {{ c.stamps }}/{{ biz.settings().loyalty.stampsNeeded }}
                  @if (ready(c)) { <span class="badge ok">reward ready</span> }
                </td>
                <td>{{ c.rewardsRedeemed }}</td>
                <td class="small">{{ c.lastVisitMillis | date: 'd MMM HH:mm' }}</td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="empty">No customers yet – add a cellphone number to a sale at the till.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class CustomersPage {
  protected readonly biz = inject(BusinessService);
  private readonly toast = inject(ToastService);
  protected readonly busy = signal(false);
  protected readonly search = signal('');
  protected enabled = false;
  protected stampsNeeded = 9;
  protected minSpend = '30.00';
  protected rewardValue = '40.00';
  private loaded = false;

  protected readonly customers = liveQuery<Customer>(() => query(this.biz.col('customers'), orderBy('spentCents', 'desc')));
  protected readonly visible = computed(() => {
    const q = this.search().trim().toLowerCase();
    const digits = q.replace(/\D/g, '').replace(/^0/, '');
    return this.customers.data().filter((c) => !q || c.name.toLowerCase().includes(q) || (digits.length >= 3 && c.phone.includes(digits)));
  });

  constructor() {
    effect(() => {
      const s = this.biz.settings();
      if (this.loaded || !s.updatedAt) return;
      this.loaded = true;
      this.enabled = s.loyalty.enabled;
      this.stampsNeeded = s.loyalty.stampsNeeded;
      this.minSpend = centsToRandString(s.loyalty.minSpendCents);
      this.rewardValue = centsToRandString(s.loyalty.rewardValueCents);
    });
  }

  protected phone(p: string) {
    return displayPhone(p);
  }

  protected ready(c: Customer) {
    return rewardReady(c, this.biz.settings().loyalty);
  }

  async save() {
    const minSpendCents = parseRandToCents(this.minSpend);
    const rewardValueCents = parseRandToCents(this.rewardValue);
    const stampsNeeded = Math.round(Number(this.stampsNeeded));
    if (minSpendCents === null || rewardValueCents === null || !(stampsNeeded >= 1 && stampsNeeded <= 50)) {
      this.toast.error('Check the amounts: 1–50 stamps, and rand values like 30.00');
      return;
    }
    this.busy.set(true);
    try {
      await this.biz.saveSettings({ loyalty: { enabled: this.enabled, stampsNeeded, minSpendCents, rewardValueCents } });
      this.toast.ok(this.enabled ? 'Stamp card is on' : 'Saved');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  downloadCsv() {
    const header = ['Name', 'Cellphone', 'Visits', 'Spent', 'Stamps', 'Rewards used', 'First visit', 'Last visit'];
    const when = (ms: number) => new Date(ms).toLocaleString('en-ZA');
    const rows = this.customers.data().map((c) => [c.name, displayPhone(c.phone), c.visits, centsToRandString(c.spentCents), c.stamps, c.rewardsRedeemed, when(c.firstVisitMillis), when(c.lastVisitMillis)]);
    const csv = [header, ...rows].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `customers-${this.biz.today()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
