import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { limit, orderBy, query, where } from '../../core/db';
import { waPhone } from '@shared/domain';
import { Product, SellerRun } from '@shared/models';
import { parseRandToCents } from '@shared/money';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { TsPipe, ZarPipe } from '../../shared/pipes';

type Tab = 'out' | 'new' | 'history';

@Component({
  selector: 'app-sellers',
  imports: [FormsModule, DatePipe, ZarPipe, TsPipe],
  template: `
    <div class="page-head"><h1>Mobile sellers</h1></div>
    <p class="muted" style="margin-top: -0.5rem">
      Hand kotas to someone selling out on the road, then count what comes back. Their ingredients leave stock when they go out and return when they come back.
    </p>

    <div class="tabs">
      <button [class.on]="tab() === 'out'" (click)="tab.set('out')">
        Out now @if (activeRuns.data().length) {<span class="badge">{{ activeRuns.data().length }}</span>}
      </button>
      <button [class.on]="tab() === 'new'" (click)="tab.set('new')">New run</button>
      <button [class.on]="tab() === 'history'" (click)="tab.set('history')">History</button>
    </div>

    @switch (tab()) {
      @case ('out') {
        @if (!activeRuns.data().length) {
          <div class="card"><p class="muted">No sellers are out right now. Start one on the <button class="link" (click)="tab.set('new')">New run</button> tab.</p></div>
        }
        @for (run of activeRuns.data(); track run.id) {
          <div class="card">
            <div class="card-head">
              <h2>{{ run.sellerName }} @if (run.sellerPhone) {<span class="tiny muted">{{ run.sellerPhone }}</span>}</h2>
              <span class="tiny muted">out since {{ run.issuedAt | ts | date: 'HH:mm' }}</span>
            </div>
            <table class="list">
              <thead><tr><th>Kota</th><th class="num">Taken</th><th class="num">Price</th><th class="num">Back</th><th class="num">Sold</th></tr></thead>
              <tbody>
                @for (line of run.lines; track line.productId) {
                  <tr>
                    <td>{{ line.name }}</td>
                    <td class="num">{{ line.quantity }}</td>
                    <td class="num">{{ line.unitPriceCents | zar }}</td>
                    <td class="num">
                      @if (settling() === run.id) {
                        <input type="number" min="0" [max]="line.quantity" inputmode="numeric" class="qty"
                          [ngModel]="back()[line.productId]" (ngModelChange)="setBack(line.productId, $event)" />
                      } @else { – }
                    </td>
                    <td class="num">{{ settling() === run.id ? sold(run, line.productId) : '–' }}</td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr><td colspan="2">Taken out (value)</td><td class="num" colspan="3">{{ run.takenValueCents | zar }}</td></tr>
              </tfoot>
            </table>

            @if (settling() === run.id) {
              <div class="settle">
                <div class="row">
                  <span>Kotas sold</span>
                  <strong>{{ soldValue(run) | zar }}</strong>
                </div>
                <label class="field">
                  <span>Cash handed in</span>
                  <input inputmode="decimal" [ngModel]="cashText()" (ngModelChange)="cashText.set($event)" placeholder="0.00" />
                </label>
                @if (cashCents() !== null) {
                  <div class="row" [class.bad]="shortfall(run) > 0" [class.good]="shortfall(run) < 0">
                    <span>{{ shortfall(run) > 0 ? 'Short by' : shortfall(run) < 0 ? 'Over by' : 'Balances' }}</span>
                    <strong>{{ shortfall(run) === 0 ? '✓' : (abs(shortfall(run)) | zar) }}</strong>
                  </div>
                }
                <div class="actions">
                  <button class="ghost" (click)="cancelSettle()" [disabled]="busy()">Cancel</button>
                  <button class="primary" (click)="confirmSettle(run)" [disabled]="busy()">Settle run</button>
                </div>
              </div>
            } @else {
              <div class="actions"><button class="primary" (click)="startSettle(run)">Count back &amp; settle</button></div>
            }
          </div>
        }
      }

      @case ('new') {
        <div class="card">
          <div class="field-row">
            <label class="field"><span>Seller's name</span><input [(ngModel)]="sellerName" maxlength="60" placeholder="e.g. Thabo" /></label>
            <label class="field"><span>Cellphone (optional)</span><input [(ngModel)]="sellerPhone" inputmode="tel" placeholder="082 123 4567" /></label>
          </div>

          @if (!products.data().length) {
            <p class="muted">No menu items yet. Add kotas under Menu first.</p>
          } @else {
            <table class="list">
              <thead><tr><th>Kota</th><th class="num">Price</th><th class="num">Take</th></tr></thead>
              <tbody>
                @for (p of products.data(); track p.id) {
                  <tr>
                    <td>{{ p.name }}</td>
                    <td class="num">{{ p.priceCents | zar }}</td>
                    <td class="num">
                      <input type="number" min="0" inputmode="numeric" class="qty"
                        [ngModel]="take()[p.id]" (ngModelChange)="setTake(p.id, $event)" />
                    </td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr><td colspan="2">Value going out</td><td class="num">{{ takeValue() | zar }}</td></tr>
              </tfoot>
            </table>
            <div class="actions">
              <button class="ghost" (click)="clearNew()" [disabled]="busy()">Clear</button>
              <button class="primary" (click)="issue()" [disabled]="busy() || takeCount() === 0">Send out {{ takeCount() ? '(' + takeCount() + ')' : '' }}</button>
            </div>
          }
        </div>
      }

      @case ('history') {
        @if (!settledRuns.data().length) {
          <div class="card"><p class="muted">No settled runs yet.</p></div>
        }
        @for (run of settledRuns.data(); track run.id) {
          <div class="card">
            <div class="card-head">
              <h2>{{ run.sellerName }}</h2>
              <span class="tiny muted">{{ run.settledAt | ts | date: 'd MMM, HH:mm' }}</span>
            </div>
            <table class="list">
              <thead><tr><th>Kota</th><th class="num">Taken</th><th class="num">Back</th><th class="num">Sold</th></tr></thead>
              <tbody>
                @for (line of run.lines; track line.productId) {
                  <tr><td>{{ line.name }}</td><td class="num">{{ line.quantity }}</td><td class="num">{{ line.returnedQty ?? 0 }}</td><td class="num">{{ line.soldQty ?? 0 }}</td></tr>
                }
              </tbody>
            </table>
            <div class="row"><span>Kotas sold</span><strong>{{ run.soldValueCents | zar }}</strong></div>
            <div class="row"><span>Cash handed in</span><strong>{{ run.cashReceivedCents | zar }}</strong></div>
            @if (run.shortfallCents) {
              <div class="row" [class.bad]="run.shortfallCents > 0" [class.good]="run.shortfallCents < 0">
                <span>{{ run.shortfallCents > 0 ? 'Short by' : 'Over by' }}</span><strong>{{ abs(run.shortfallCents) | zar }}</strong>
              </div>
            }
          </div>
        }
      }
    }
  `,
  styles: [
    `
      .list { width: 100%; border-collapse: collapse; margin: 0.5rem 0 }
      .list th, .list td { padding: 0.45rem 0.4rem; text-align: left; border-bottom: 1px solid var(--line, #e5e7eb) }
      .list .num { text-align: right }
      .list tfoot td { font-weight: 600; border-bottom: none }
      .qty { width: 4.5rem; text-align: right }
      .field { display: flex; flex-direction: column; gap: 0.25rem; margin: 0.4rem 0 }
      .field-row { display: flex; gap: 0.75rem; flex-wrap: wrap }
      .field-row .field { flex: 1 1 12rem }
      .settle { margin-top: 0.75rem; padding-top: 0.5rem; border-top: 1px solid var(--line, #e5e7eb) }
      .row { display: flex; justify-content: space-between; padding: 0.3rem 0 }
      .row.bad strong { color: var(--bad, #dc2626) }
      .row.good strong { color: var(--good, #16a34a) }
      .actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 0.6rem }
      .badge { background: var(--accent, #2563eb); color: #fff; border-radius: 999px; padding: 0 0.4rem; font-size: 0.75rem; margin-left: 0.3rem }
      button.link { background: none; border: none; color: var(--accent, #2563eb); cursor: pointer; padding: 0; text-decoration: underline }
    `,
  ],
})
export class SellersPage {
  private readonly api = inject(ApiService);
  private readonly biz = inject(BusinessService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly tab = signal<Tab>('out');
  protected readonly busy = signal(false);

  protected readonly products = liveQuery<Product>(() => query(this.biz.col('products'), where('active', '==', true), orderBy('sortOrder')));
  protected readonly activeRuns = liveQuery<SellerRun>(() => query(this.biz.col('sellerRuns'), where('status', '==', 'out'), orderBy('issuedAt', 'desc')));
  protected readonly settledRuns = liveQuery<SellerRun>(() =>
    this.tab() === 'history' ? query(this.biz.col('sellerRuns'), where('status', '==', 'settled'), orderBy('settledAt', 'desc'), limit(50)) : null,
  );

  // ---- new run ----
  protected sellerName = '';
  protected sellerPhone = '';
  protected readonly take = signal<Record<string, string>>({});

  protected setTake(id: string, v: string) {
    this.take.update((t) => ({ ...t, [id]: v }));
  }
  protected clearNew() {
    this.take.set({});
    this.sellerName = '';
    this.sellerPhone = '';
  }
  private qtyOf(v: string | undefined): number {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  protected readonly takeCount = computed(() => this.products.data().reduce((s, p) => s + this.qtyOf(this.take()[p.id]), 0));
  protected readonly takeValue = computed(() => this.products.data().reduce((s, p) => s + this.qtyOf(this.take()[p.id]) * p.priceCents, 0));

  async issue() {
    const name = this.sellerName.trim();
    if (name.length < 2) return this.toast.error("Enter the seller's name");
    const phone = this.sellerPhone.trim();
    if (phone && !waPhone(phone)) return this.toast.error('Check the cellphone number, e.g. 082 123 4567');
    const lines = this.products
      .data()
      .map((p) => ({ productId: p.id, quantity: this.qtyOf(this.take()[p.id]) }))
      .filter((l) => l.quantity > 0);
    if (!lines.length) return this.toast.error('Enter how many of each kota the seller is taking');
    this.busy.set(true);
    try {
      await this.api.call('issueSellerRun', { sellerName: name, ...(phone ? { sellerPhone: phone } : {}), lines });
      this.toast.ok(`${name} sent out with ${lines.reduce((s, l) => s + l.quantity, 0)} kota(s)`);
      this.clearNew();
      this.tab.set('out');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  // ---- settle ----
  protected readonly settling = signal<string | null>(null);
  protected readonly back = signal<Record<string, string>>({});
  protected readonly cashText = signal('');

  protected startSettle(run: SellerRun) {
    this.settling.set(run.id);
    this.back.set({});
    this.cashText.set('');
  }
  protected cancelSettle() {
    this.settling.set(null);
    this.back.set({});
    this.cashText.set('');
  }
  protected setBack(id: string, v: string) {
    this.back.update((t) => ({ ...t, [id]: v }));
  }
  private backOf(line: SellerRun['lines'][number]): number {
    const n = Math.floor(Number(this.back()[line.productId]));
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), line.quantity) : 0;
  }
  protected sold(run: SellerRun, productId: string): number {
    const line = run.lines.find((l) => l.productId === productId);
    return line ? line.quantity - this.backOf(line) : 0;
  }
  protected soldValue(run: SellerRun): number {
    return run.lines.reduce((s, l) => s + (l.quantity - this.backOf(l)) * l.unitPriceCents, 0);
  }
  protected readonly cashCents = computed(() => (this.cashText().trim() ? parseRandToCents(this.cashText()) : null));
  protected shortfall(run: SellerRun): number {
    return this.soldValue(run) - (this.cashCents() ?? 0);
  }
  protected abs(n: number) {
    return Math.abs(n);
  }

  async confirmSettle(run: SellerRun) {
    const cashReceivedCents = this.cashCents();
    if (cashReceivedCents === null) return this.toast.error('Enter the cash the seller handed in (0 if none)');
    const returns = run.lines.map((l) => ({ productId: l.productId, returnedQty: this.backOf(l) }));
    this.busy.set(true);
    try {
      const res = await this.api.call('settleSellerRun', { runId: run.id, returns, cashReceivedCents });
      this.cancelSettle();
      this.toast.ok(
        res.shortfallCents > 0
          ? `Settled – ${run.sellerName} is short ${(res.shortfallCents / 100).toFixed(2)}`
          : `Settled – ${run.sellerName}'s cash balances`,
      );
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
