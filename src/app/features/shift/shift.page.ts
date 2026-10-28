import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { orderBy, query, where } from 'firebase/firestore';
import { ApiResponse } from '@shared/api';
import { Ingredient } from '@shared/models';
import { formatZar, parseRandToCents } from '@shared/money';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ConfirmService } from '../../core/confirm.service';
import { OutboxService } from '../../core/outbox.service';
import { ToastService } from '../../core/toast.service';
import { TsPipe, ZarPipe } from '../../shared/pipes';

/** South African notes and coins, in cents. */
const DENOMINATIONS = [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10];

@Component({
  selector: 'app-shift',
  imports: [FormsModule, DatePipe, ZarPipe, TsPipe],
  template: `
    <div class="page-head"><h1>Shift</h1></div>

    @if (result(); as r) {
      <div class="card">
        <h2>Shift closed</h2>
        <div class="alert" [class.ok]="r.differenceCents === 0" [class.bad]="r.differenceCents !== 0">
          @if (r.differenceCents === 0) {
            Cash balanced. Well done!
          } @else {
            Cash is {{ r.differenceCents < 0 ? 'short' : 'over' }} by {{ abs(r.differenceCents) | zar }}. The owner has been notified with your explanation.
          }
        </div>
        @if (r.stockVariances.length) {
          <p class="small">{{ r.stockVariances.length }} stock item(s) did not match and were sent to the owner to review.</p>
        }
        <button class="btn block" (click)="result.set(null)">Done</button>
      </div>
    } @else if (biz.openShiftLoading()) {
      <p class="empty">Loading…</p>
    } @else if (!biz.openShift()) {
      <!-- ---------- OPEN ---------- -->
      <form class="card" (ngSubmit)="open()">
        <h2>Open the shop</h2>
        <p class="muted">Count the cash in the till before the first sale. This is your opening float.</p>
        <label class="field">
          <span>Opening float (R)</span>
          <input class="money-input" inputmode="decimal" name="float" [(ngModel)]="floatText" placeholder="0.00" required />
        </label>
        <h3>Opening checklist</h3>
        @for (item of biz.settings().openingChecklist; track item) {
          <label class="check"><input type="checkbox" [checked]="openChecks().has(item)" (change)="toggle(openChecks, item)" />{{ item }}</label>
        }
        <button class="btn primary block xl" style="margin-top: 1rem" [disabled]="busy()">Open shift</button>
      </form>
    } @else if (!biz.myOpenShift()) {
      <div class="alert info">{{ biz.openShift()!.employeeName }}'s shift is open (since {{ biz.openShift()!.openedAt | ts | date: 'HH:mm' }}). Only they or the owner can close it.</div>
    } @else {
      @let shift = biz.myOpenShift()!;
      <div class="card">
        <div class="row between">
          <div>
            <h2 style="margin: 0">{{ shift.employeeName }}'s shift</h2>
            <span class="muted small">Opened {{ shift.openedAt | ts | date: 'EEE d MMM, HH:mm' }}</span>
          </div>
          <span class="badge ok">Open</span>
        </div>
        <div class="divider"></div>
        <div class="kv">
          <span>Orders on this shift</span><span>{{ mySales.data().length }}</span>
          <span>Sales on this shift</span><span>{{ shiftSalesTotal() | zar }}</span>
        </div>
      </div>

      <div class="tabs">
        <button [class.on]="tab() === 'close'" (click)="tab.set('close')">Cash up & close</button>
        <button [class.on]="tab() === 'payout'" (click)="tab.set('payout')">Cash paid out</button>
      </div>

      @if (tab() === 'payout') {
        <form class="card" (ngSubmit)="payout()">
          <h2>Take cash out of the till</h2>
          <p class="muted small">For cash drops to the owner or other cash leaving the till. For purchases use Expenses or Stock › Delivery.</p>
          <label class="field"><span>Amount (R)</span><input class="money-input" inputmode="decimal" name="pa" [(ngModel)]="payoutText" /></label>
          <label class="field"><span>Reason</span><input name="pr" [(ngModel)]="payoutReason" placeholder="e.g. Cash drop to owner" /></label>
          <button class="btn primary block" [disabled]="busy()">Record payout</button>
        </form>
      } @else {
        @if (outbox.count()) {
          <div class="alert bad">
            {{ outbox.count() }} sale(s) on this phone have not reached the server yet. Connect to the internet and wait for them to send before closing.
            <button type="button" class="btn small" (click)="outbox.flush()">Send now</button>
          </div>
        }
        <form class="card" (ngSubmit)="close()">
          <h2>1. Count the cash</h2>
          <p class="muted small">Count all notes and coins in the till, including the float.</p>
          <div class="denoms">
            @for (d of denoms; track d) {
              <label>
                <span>{{ d >= 100 ? 'R' + d / 100 : d + 'c' }}</span>
                <input type="number" inputmode="numeric" min="0" [ngModel]="counts()[d] || null" (ngModelChange)="setCount(d, $event)" [name]="'d' + d" />
              </label>
            }
          </div>
          <label class="field" style="margin-top: .75rem">
            <span>Total counted (R)
              <span class="hint">– adds up from the notes & coins above, or type the total yourself</span>
            </span>
            <input class="money-input" inputmode="decimal" name="countedTotal" placeholder="0.00"
              [ngModel]="typedTotal() ?? randString(denomTotal())" (ngModelChange)="typedTotal.set($event)" />
          </label>
          @if (typedTotal() !== null) {
            <p class="tiny" style="margin-top: -.5rem">
              @if (typedCents() === null) {
                <span style="color: var(--bad)">Not a valid amount – e.g. 1250.50</span>
              } @else if (denomTotal() && typedCents() !== denomTotal()) {
                Using the typed total. The notes & coins add up to {{ denomTotal() | zar }}.
              } @else {
                Using the typed total.
              }
              <button type="button" class="btn ghost small" (click)="typedTotal.set(null)">Use notes & coins total</button>
            </p>
          }

          <div class="divider"></div>
          <h2>2. Card machine</h2>
          <label class="field">
            <span>Card machine batch total (R) <span class="hint">– from the end-of-day slip. Leave empty if no card machine.</span></span>
            <input inputmode="decimal" name="card" [(ngModel)]="cardText" />
          </label>

          <div class="divider"></div>
          <h2>3. Count the stock</h2>
          @if (dailyItems().length) {
            <p class="muted small">Count what is physically left of these items. All of them must be counted to close.</p>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Item</th><th>Unit</th><th style="width: 120px">Counted</th></tr></thead>
                <tbody>
                  @for (i of dailyItems(); track i.id) {
                    <tr>
                      <td>{{ i.name }}</td>
                      <td class="muted">{{ i.unit }}</td>
                      <td>
                        <input type="number" inputmode="decimal" min="0" step="any" required [name]="'s' + i.id"
                          [ngModel]="stock()[i.id] ?? null" (ngModelChange)="setStock(i.id, $event)" />
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="muted small">
              No items need counting today.
              @if (auth.isOwner()) {
                Mark items as <strong>Must be counted at every close</strong> in Ingredients to count them here.
              }
            </p>
          }

          <div class="divider"></div>
          <h2>4. Closing checklist</h2>
          @for (item of biz.settings().closingChecklist; track item) {
            <label class="check"><input type="checkbox" [checked]="closeChecks().has(item)" (change)="toggle(closeChecks, item)" />{{ item }}</label>
          }

          @if (needExplanation()) {
            <div class="alert warn" style="margin-top: 1rem">The cash count does not match. Recount, or explain the difference below.</div>
            <label class="field"><span>Explanation</span><textarea name="exp" [(ngModel)]="explanation" required></textarea></label>
          }
          <label class="field" style="margin-top: 1rem"><span>Notes for the owner (optional)</span><textarea name="notes" [(ngModel)]="notes"></textarea></label>

          <button class="btn dark block xl" [disabled]="busy()">{{ busy() ? 'Closing…' : 'Submit cash-up & close shift' }}</button>
          <p class="tiny" style="margin-top: .5rem">Once submitted the count cannot be changed.</p>
        </form>
      }
    }
  `,
})
export class ShiftPage {
  protected readonly biz = inject(BusinessService);
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly outbox = inject(OutboxService);
  private readonly confirm = inject(ConfirmService);
  protected readonly denoms = DENOMINATIONS;
  protected readonly abs = Math.abs;

  protected readonly busy = signal(false);
  protected readonly tab = signal<'close' | 'payout'>('close');
  protected readonly openChecks = signal(new Set<string>());
  protected readonly closeChecks = signal(new Set<string>());
  protected readonly counts = signal<Record<number, number>>({});
  protected readonly stock = signal<Record<string, number | null>>({});
  protected readonly needExplanation = signal(false);
  protected readonly result = signal<ApiResponse<'closeShift'> | null>(null);
  protected floatText = '';
  protected payoutText = '';
  protected payoutReason = '';
  protected cardText = '';
  protected explanation = '';
  protected notes = '';

  protected readonly ingredients = liveQuery<Ingredient>(() => query(this.biz.col('ingredients'), where('active', '==', true), orderBy('name')));
  /** only items the owner marked "Must be counted at every close" are counted at cash-up */
  protected readonly dailyItems = computed(() => this.ingredients.data().filter((i) => i.countDaily));
  protected readonly mySales = liveQuery<{ id: string; totalCents: number; status: string }>(() => {
    const s = this.biz.myOpenShift();
    if (!s) return null;
    const base = query(this.biz.col('sales'), where('shiftId', '==', s.id));
    // Security rules only let employees list their own sales.
    return this.auth.isOwner() ? base : query(base, where('employeeId', '==', this.auth.uid()));
  });
  protected readonly shiftSalesTotal = computed(() => this.mySales.data().reduce((s, x) => s + (x.status === 'refunded' ? 0 : x.totalCents), 0));
  protected readonly denomTotal = computed(() => Object.entries(this.counts()).reduce((s, [d, n]) => s + Number(d) * (n || 0), 0));
  /** null = use the notes & coins total; otherwise what the cashier typed */
  protected readonly typedTotal = signal<string | null>(null);
  protected readonly typedCents = computed(() => {
    const t = this.typedTotal();
    return t === null ? null : parseRandToCents(t.trim() === '' ? '0' : t);
  });
  protected readonly countedCents = computed(() => (this.typedTotal() === null ? this.denomTotal() : (this.typedCents() ?? 0)));

  protected randString(cents: number) {
    return cents ? (cents / 100).toFixed(2) : '';
  }

  toggle(set: typeof this.openChecks, item: string) {
    set.update((s) => {
      const next = new Set(s);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  }

  setCount(d: number, n: number | null) {
    this.counts.update((c) => ({ ...c, [d]: Math.max(0, Math.floor(Number(n) || 0)) }));
  }

  setStock(id: string, n: number | null) {
    this.stock.update((s) => ({ ...s, [id]: n === null || (n as unknown) === '' ? null : Number(n) }));
  }

  async open() {
    const cents = parseRandToCents(this.floatText);
    if (cents === null) return this.toast.error('Enter the opening float, e.g. 500');
    const checklist = this.biz.settings().openingChecklist.map((item) => ({ item, done: this.openChecks().has(item) }));
    const notDone = checklist.filter((c) => !c.done);
    const ok = await this.confirm.ask({
      title: 'Open the shift?',
      details: [
        { label: 'Opening float', value: formatZar(cents), strong: true },
        { label: 'Checklist', value: `${checklist.length - notDone.length} of ${checklist.length} done` },
      ],
      warning: notDone.length ? `Not ticked: ${notDone.map((c) => c.item).join(', ')}` : undefined,
      confirmText: 'Open shift',
    });
    if (!ok) return;
    await this.run(async () => {
      await this.api.call('openShift', { openingFloatCents: cents, checklist });
      this.toast.ok('Shift opened – you can start selling');
    });
  }

  async payout() {
    const cents = parseRandToCents(this.payoutText);
    if (!cents) return this.toast.error('Enter an amount');
    await this.run(async () => {
      await this.api.call('recordPayout', { amountCents: cents, reason: this.payoutReason });
      this.payoutText = '';
      this.payoutReason = '';
      this.toast.ok('Payout recorded');
    });
  }

  async close() {
    const shift = this.biz.myOpenShift();
    if (!shift) return;
    if (this.outbox.count()) return this.toast.error('Some sales are still on this phone – connect to the internet so they send first');
    const missing = this.ingredients.data().filter((i) => i.countDaily && (this.stock()[i.id] === null || this.stock()[i.id] === undefined));
    if (missing.length) return this.toast.error(`Count these items first: ${missing.map((i) => i.name).join(', ')}`);
    const card = this.cardText.trim() ? parseRandToCents(this.cardText) : null;
    if (this.cardText.trim() && card === null) return this.toast.error('Card machine total is not a valid amount');
    if (this.typedTotal() !== null && this.typedCents() === null) return this.toast.error('The total counted is not a valid amount');
    const closing = this.biz.settings().closingChecklist;
    const ticked = closing.filter((item) => this.closeChecks().has(item)).length;
    const counted = Object.values(this.stock()).filter((v) => v !== null && !Number.isNaN(v)).length;
    const ok = await this.confirm.ask({
      title: 'Submit cash-up and close the shift?',
      message: 'Check these numbers before you submit.',
      details: [
        { label: 'Cash counted', value: formatZar(this.countedCents()), strong: true },
        { label: 'Card machine total', value: card === null ? 'Not entered' : formatZar(card) },
        { label: 'Stock items counted', value: `${counted} of ${this.dailyItems().length}` },
        { label: 'Closing checklist', value: `${ticked} of ${closing.length} done` },
      ],
      warning: 'Once submitted, the count cannot be changed.',
      confirmText: 'Submit & close shift',
      cancelText: 'Go back',
      tone: 'dark',
    });
    if (!ok) return;
    await this.run(async () => {
      try {
        const res = await this.api.call('closeShift', {
          shiftId: shift.id,
          countedCashCents: this.countedCents(),
          cardTerminalTotalCents: card,
          explanation: this.explanation.trim() || undefined,
          checklist: this.biz.settings().closingChecklist.map((item) => ({ item, done: this.closeChecks().has(item) })),
          stockCounts: Object.entries(this.stock())
            .filter(([id]) => this.dailyItems().some((i) => i.id === id))
            .filter(([, v]) => v !== null && !Number.isNaN(v))
            .map(([ingredientId, countedQty]) => ({ ingredientId, countedQty: countedQty as number })),
          notes: this.notes.trim() || undefined,
        });
        this.result.set(res);
      } catch (err) {
        if ((err as Error).message.includes('Explain the cash difference')) {
          this.needExplanation.set(true);
        }
        throw err;
      }
    });
  }

  private async run(fn: () => Promise<void>) {
    this.busy.set(true);
    try {
      await fn();
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
