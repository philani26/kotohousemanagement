import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardColumn, CardRow, CardTransaction, PROVIDERS, ParsedCsv, guessColumns, parseCsv, toCardRows } from '@shared/cards';
import { Sale } from '@shared/models';
import { ApiService } from '../../core/api.service';
import { BusinessService } from '../../core/business.service';
import { limit, orderBy, query, where } from '../../core/db';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { TsPipe, ZarPipe } from '../../shared/pipes';

const COLUMNS: { key: CardColumn; label: string; required?: boolean }[] = [
  { key: 'date', label: 'Date (and time)', required: true },
  { key: 'time', label: 'Time, if in its own column' },
  { key: 'amount', label: 'Amount', required: true },
  { key: 'reference', label: 'Reference / auth code' },
  { key: 'status', label: 'Status (approved, declined…)' },
  { key: 'last4', label: 'Card number' },
  { key: 'terminal', label: 'Terminal / device' },
];

/** The card part of a sale (all of it, unless part was paid in cash). */
function cardPart(s: Sale): number {
  return s.totalCents - Math.min(s.payment.cashCents ?? 0, s.totalCents);
}

/**
 * Owner: card machines of any provider. Payments from the machine (uploaded
 * from the provider's export, or pushed live) are matched to the card sales
 * rung up in the app; what doesn't match is shown here and alerted.
 */
@Component({
  selector: 'app-cards',
  imports: [FormsModule, DatePipe, ZarPipe, TsPipe],
  template: `
    <div class="page-head"><h1>💳 Card machines</h1></div>

    <div class="card">
      <h2>Upload card payments</h2>
      <p class="small muted">
        Works with any card machine. Download your transactions as a <strong>CSV</strong> from your provider's portal or app
        (Yoco, iKhokha, Adumo, your bank…) and upload it here. Each payment is matched to its card sale
        (same amount, within 15 minutes) and the sale is marked <strong>verified</strong>. Uploading the same file twice is harmless.
      </p>
      <div class="row" style="gap: .5rem; align-items: flex-end">
        <label class="field" style="margin: 0; min-width: 160px"><span>Provider</span>
          <select name="provider" [(ngModel)]="provider">
            @for (p of providers; track p) { <option [value]="p">{{ p }}</option> }
          </select>
        </label>
        <label class="field" style="margin: 0; flex: 1; min-width: 220px"><span>CSV file</span>
          <input type="file" accept=".csv,text/csv,text/plain" (change)="read($event)" />
        </label>
      </div>

      @if (csv(); as c) {
        <h3 style="margin-top: 1rem">Which column is which?</h3>
        <p class="tiny">Guessed from the column names – check them against the preview.</p>
        <div class="row" style="gap: .5rem">
          @for (col of columns; track col.key) {
            <label class="field" style="margin: 0; min-width: 150px"><span>{{ col.label }}{{ col.required ? ' *' : '' }}</span>
              <select [name]="'col-' + col.key" [ngModel]="cols()[col.key]" (ngModelChange)="setCol(col.key, +$event)">
                <option [value]="-1">– none –</option>
                @for (h of c.headers; track $index) { <option [value]="$index">{{ h || 'column ' + ($index + 1) }}</option> }
              </select>
            </label>
          }
        </div>
        <div class="table-wrap" style="margin-top: .75rem">
          <table>
            <thead><tr><th>When</th><th>Amount</th><th>Reference</th><th>Status</th><th>Card</th></tr></thead>
            <tbody>
              @for (r of converted().rows.slice(0, 5); track $index) {
                <tr>
                  <td class="small">{{ r.atMillis | date: 'd MMM yyyy HH:mm' }}</td>
                  <td [class.neg]="r.amountCents < 0">{{ r.amountCents | zar }}</td>
                  <td class="small">{{ r.reference ?? '' }}</td>
                  <td class="small">{{ r.status ?? '' }}</td>
                  <td class="small">{{ r.last4 ? '•••• ' + r.last4 : '' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="empty">Choose the date and amount columns</td></tr>
              }
            </tbody>
          </table>
        </div>
        <p class="small">{{ converted().rows.length }} payment(s) read from {{ c.rows.length }} row(s)@if (converted().problems.length) {, <span class="neg">{{ converted().problems.length }} can't be read</span>}.</p>
        @if (converted().problems.length) {
          <details><summary class="tiny">Rows that can't be read</summary>
            @for (p of converted().problems.slice(0, 20); track p) { <div class="tiny">{{ p }}</div> }
          </details>
        }
        <button class="btn primary" style="margin-top: .5rem" [disabled]="busy() || !converted().rows.length" (click)="upload()">
          Import {{ converted().rows.length }} payment(s)
        </button>
      }
      @if (result(); as r) {
        <div class="alert info" style="margin-top: .75rem">
          {{ r.added }} new payment(s){{ r.duplicates ? ', ' + r.duplicates + ' already imported' : '' }}.
          <strong>{{ r.matched }} matched</strong> to sales{{ r.unmatched ? ', ' + r.unmatched + ' without a sale (below)' : '' }}.
        </div>
      }
    </div>

    <div class="card">
      <div class="card-head"><h2>Card payments with no sale</h2><span class="badge" [class.bad]="unmatched().length">{{ unmatched().length }}</span></div>
      <p class="small muted">The machine took the money but no card sale for that amount was rung up within 15 minutes. Often food was handed over without a sale – or the sale was rung up as cash.</p>
      @for (t of unmatched(); track t.id) {
        <div class="list-item">
          <div class="main">
            <div class="title">{{ t.amountCents | zar }} · {{ t.atMillis | date: 'EEE d MMM HH:mm' }}</div>
            <div class="tiny">{{ t.provider }}{{ t.reference ? ' · ' + t.reference : '' }}{{ t.last4 ? ' · •••• ' + t.last4 : '' }}{{ t.terminal ? ' · ' + t.terminal : '' }}</div>
          </div>
          <button class="btn small" (click)="startMatch(t)">Match to a sale</button>
        </div>
      } @empty {
        <p class="empty">None – every card payment has its sale 👍</p>
      }
    </div>

    <div class="card">
      <div class="card-head"><h2>Card sales not on a machine report</h2><span class="badge" [class.warn]="unconfirmed().length">{{ unconfirmed().length }}</span></div>
      <p class="small muted">Card sales of the last week that no uploaded or pushed payment confirms yet. If your latest report is uploaded, check these: the sale may have been paid another way.</p>
      @for (s of unconfirmed(); track s.id) {
        <div class="list-item">
          <div class="main">
            <div class="title">#{{ s.receiptNo }} · {{ cardOf(s) | zar }} by card</div>
            <div class="tiny">{{ (s.soldAt ?? s.createdAt) | ts | date: 'EEE d MMM HH:mm' }} · {{ s.employeeName }}</div>
          </div>
        </div>
      } @empty {
        <p class="empty">None</p>
      }
    </div>

    <div class="card">
      <h2>Recently matched</h2>
      @for (t of matched(); track t.id) {
        <div class="list-item">
          <div class="main">
            <div class="title">{{ t.amountCents | zar }} · {{ t.atMillis | date: 'EEE d MMM HH:mm' }}</div>
            <div class="tiny">{{ t.provider }}{{ t.reference ? ' · ' + t.reference : '' }} · {{ t.matchedBy === 'auto' ? 'matched automatically' : 'matched by hand' }}</div>
          </div>
          <button class="btn small ghost" (click)="undo(t)">Undo</button>
        </div>
      } @empty {
        <p class="empty">Nothing matched yet</p>
      }
    </div>

    <div class="card">
      <h2>Live link (automatic)</h2>
      <p class="small muted">
        If your provider – or a tool like Zapier or Make connected to it – can send each card payment to a web address,
        use this link and payments are matched as they happen, without uploads. Keep the secret private.
      </p>
      @if (hook(); as h) {
        <label class="field"><span>Address (POST)</span><input readonly [value]="h.url" (focus)="$any($event.target).select()" /></label>
        <label class="field"><span>Header {{ h.header }}</span><input readonly [value]="showSecret() ? h.token : '••••••••••••••••'" (focus)="$any($event.target).select()" /></label>
        <div class="row" style="gap: .5rem">
          <button class="btn small" (click)="showSecret.set(!showSecret())">{{ showSecret() ? 'Hide' : 'Show' }} secret</button>
          <button class="btn small ghost" (click)="loadHook(true)">Make a new secret</button>
        </div>
        <details style="margin-top: .5rem"><summary class="tiny">What to send</summary>
          <pre class="tiny" style="white-space: pre-wrap">{{ example }}</pre>
        </details>
      } @else {
        <button class="btn" (click)="loadHook(false)">Show the live link</button>
      }
    </div>

    @if (matching(); as t) {
      <div class="dialog-backdrop" (click)="matching.set(null)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <h2>Which sale was {{ t.amountCents | zar }}?</h2>
          <p class="small muted">Card sales of the same amount around {{ t.atMillis | date: 'EEE d MMM HH:mm' }} that have no machine payment yet.</p>
          @for (s of candidates(); track s.id) {
            <div class="list-item">
              <div class="main">
                <div class="title">#{{ s.receiptNo }} · {{ cardOf(s) | zar }}</div>
                <div class="tiny">{{ (s.soldAt ?? s.createdAt) | ts | date: 'EEE d MMM HH:mm' }} · {{ s.employeeName }}</div>
              </div>
              <button class="btn small primary" [disabled]="busy()" (click)="match(t, s)">This one</button>
            </div>
          } @empty {
            <p class="empty">No card sale of this amount nearby. If the food was handed over without a sale, speak to the cashier on duty.</p>
          }
          <button class="btn" style="margin-top: .5rem" (click)="matching.set(null)">Close</button>
        </div>
      </div>
    }
  `,
})
export class CardsPage {
  private readonly biz = inject(BusinessService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly providers = PROVIDERS;
  protected readonly columns = COLUMNS;
  protected provider = PROVIDERS[0];
  protected readonly busy = signal(false);
  protected readonly csv = signal<ParsedCsv | null>(null);
  protected readonly cols = signal<Record<CardColumn, number>>({ date: -1, time: -1, amount: -1, reference: -1, status: -1, last4: -1, terminal: -1 });
  protected readonly converted = computed(() => {
    const c = this.csv();
    return c ? toCardRows(c, this.cols()) : { rows: [] as CardRow[], problems: [] as string[] };
  });
  protected readonly result = signal<{ added: number; duplicates: number; matched: number; unmatched: number } | null>(null);
  protected readonly hook = signal<{ url: string; header: string; token: string } | null>(null);
  protected readonly showSecret = signal(false);
  protected readonly matching = signal<CardTransaction | null>(null);
  protected readonly example = JSON.stringify(
    { provider: 'Yoco', transactions: [{ at: '2026-11-24T14:05:00+02:00', amount: '35.00', reference: 'AUTH123', status: 'Approved' }] },
    null,
    2,
  );

  private readonly weekAgo = computed(() => {
    const d = new Date(`${this.biz.today()}T12:00:00`);
    d.setDate(d.getDate() - 8);
    return d.toISOString().slice(0, 10);
  });
  private readonly openTxns = liveQuery<CardTransaction>(() =>
    query(this.biz.col('cardTransactions'), where('matchedSaleId', '==', null), where('dayKey', '>=', this.weekAgo()), limit(500)),
  );
  protected readonly unmatched = computed(() =>
    this.openTxns
      .data()
      .filter((t) => t.approved && t.atMillis < Date.now() - 15 * 60_000)
      .sort((a, b) => b.atMillis - a.atMillis),
  );
  private readonly cardSales = liveQuery<Sale>(() =>
    query(this.biz.col('sales'), where('payment.method', '==', 'card'), where('dayKey', '>=', this.weekAgo()), limit(2000)),
  );
  protected readonly unconfirmed = computed(() =>
    this.cardSales
      .data()
      .filter((s) => !s.payment.cardTxnId && !s.payment.yocoCheckoutId && !s.payment.verified && s.status !== 'refunded')
      .filter((s) => ((s.soldAt ?? s.createdAt)?.toMillis() ?? 0) < Date.now() - 30 * 60_000)
      .sort((a, b) => b.receiptNo - a.receiptNo),
  );
  private readonly matchedTxns = liveQuery<CardTransaction>(() =>
    query(this.biz.col('cardTransactions'), where('dayKey', '>=', this.weekAgo()), orderBy('atMillis', 'desc'), limit(300)),
  );
  protected readonly matched = computed(() => this.matchedTxns.data().filter((t) => t.matchedSaleId).slice(0, 20));
  protected readonly candidates = computed(() => {
    const t = this.matching();
    if (!t) return [];
    return this.cardSales
      .data()
      .filter((s) => !s.payment.cardTxnId && !s.payment.yocoCheckoutId && cardPart(s) === t.amountCents)
      .filter((s) => Math.abs(((s.soldAt ?? s.createdAt)?.toMillis() ?? 0) - t.atMillis) < 36 * 3_600_000)
      .sort((a, b) => Math.abs(((a.soldAt ?? a.createdAt)?.toMillis() ?? 0) - t.atMillis) - Math.abs(((b.soldAt ?? b.createdAt)?.toMillis() ?? 0) - t.atMillis));
  });

  protected cardOf(s: Sale) {
    return cardPart(s);
  }

  async read(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    this.result.set(null);
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return this.toast.error('That file is too big (max 5 MB) – export a shorter period');
    const parsed = parseCsv(await file.text());
    if (!parsed.headers.length || !parsed.rows.length) return this.toast.error("That file has no rows – is it a CSV export of transactions?");
    this.csv.set(parsed);
    this.cols.set(guessColumns(parsed.headers));
  }

  setCol(key: CardColumn, index: number) {
    this.cols.update((c) => ({ ...c, [key]: index }));
  }

  async upload() {
    const rows = this.converted().rows;
    this.busy.set(true);
    try {
      let total = { added: 0, duplicates: 0, matched: 0, unmatched: 0 };
      // big exports go up in parts the server accepts
      for (let i = 0; i < rows.length; i += 5000) {
        const r = await this.api.call('importCardTransactions', { provider: this.provider, rows: rows.slice(i, i + 5000) });
        total = { added: total.added + r.added, duplicates: total.duplicates + r.duplicates, matched: total.matched + r.matched, unmatched: r.unmatched };
      }
      this.result.set(total);
      this.csv.set(null);
      this.toast.ok(`${total.matched} card payment(s) matched to sales`);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  startMatch(t: CardTransaction) {
    this.matching.set(t);
  }

  async match(t: CardTransaction, s: Sale) {
    await this.run(async () => {
      await this.api.call('matchCardTransaction', { transactionId: t.id, saleId: s.id });
      this.toast.ok(`Matched to receipt #${s.receiptNo}`);
      this.matching.set(null);
    });
  }

  async undo(t: CardTransaction) {
    await this.run(() => this.api.call('matchCardTransaction', { transactionId: t.id }));
  }

  async loadHook(renew: boolean) {
    await this.run(async () => {
      this.hook.set(await this.api.call('cardWebhook', renew ? { renew: true } : {}));
      if (renew) this.toast.ok('New secret made – the old one no longer works');
    });
  }

  private async run(fn: () => Promise<unknown>) {
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
