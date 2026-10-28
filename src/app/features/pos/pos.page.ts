import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { orderBy, query, where } from 'firebase/firestore';
import { Ingredient, PaymentMethod, Product, Recipe } from '@shared/models';
import { discountPercent, inOrderQueue } from '@shared/domain';
import { parseRandToCents } from '@shared/money';
import { ApiError, ApiService } from '../../core/api.service';
import { ConfirmService } from '../../core/confirm.service';
import { OrdersService } from '../../core/orders.service';
import { OutboxService } from '../../core/outbox.service';
import { AuthService } from '../../core/auth.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { newSaleId } from '../../shared/ids';
import { ZarPipe } from '../../shared/pipes';
import { Receipt, printReceipt, whatsappReceiptUrl } from '../../shared/receipt';
import { OrderQueueComponent } from '../../shared/order-queue.component';

interface CartLine {
  product: Product;
  quantity: number;
}

@Component({
  selector: 'app-pos',
  imports: [FormsModule, RouterLink, ZarPipe, OrderQueueComponent],
  template: `
    @if (outbox.count()) {
      <div class="alert" [class.warn]="!outbox.failed().length" [class.bad]="outbox.failed().length">
        @if (outbox.pending().length) {
          <strong>{{ outbox.pending().length }} sale(s) saved on this phone, waiting for internet.</strong>
          They will be sent automatically. Keep selling. Do not clear the browser or sign out.
          <button class="btn small" style="margin-left: .5rem" (click)="outbox.flush()">Send now</button>
        }
        @for (f of outbox.failed(); track f.request.saleId) {
          <div style="margin-top: .35rem">
            <strong>Sale of {{ f.request.expectedTotalCents ?? 0 | zar }} was refused:</strong> {{ f.error }}
            <button class="btn small" (click)="outbox.retry(f.request.saleId)">Retry</button>
            <button class="btn small ghost" (click)="discardFailed(f.request.saleId)">Discard</button>
          </div>
        }
      </div>
    }
    @if (!biz.openShiftLoading() && !biz.myOpenShift()) {
      <div class="alert warn">
        @if (biz.openShift()) {
          {{ biz.openShift()!.employeeName }}'s shift is open on this till. Only they (or the owner) can sell.
        } @else {
          <strong>No shift is open.</strong> Count the float and open the shift before selling.
          <a class="btn primary small" routerLink="/shift" style="margin-left: .5rem">Open shift</a>
        }
      </div>
    }

    <div class="pos">
      <section>
        <div class="cat-tabs" role="tablist">
          <button [class.on]="category() === 'all'" (click)="category.set('all')">All</button>
          @for (c of categories(); track c) {
            <button [class.on]="category() === c" (click)="category.set(c)">{{ labels()[c] ?? c }}</button>
          }
        </div>
        @if (products.loading()) {
          <p class="empty">Loading menu…</p>
        } @else if (products.data().length === 0) {
          <div class="card empty">
            No products on the menu yet.
            @if (auth.isOwner()) {
              <br /><a routerLink="/products">Set up the menu</a>
            }
          </div>
        }
        <div class="product-grid">
          @for (p of visible(); track p.id) {
            <button class="product-btn" [style.border-left-color]="p.colour || null" (click)="add(p)" [disabled]="!biz.myOpenShift()">
              <span class="name">{{ p.name }}</span>
              <span class="price">{{ p.priceCents | zar }}</span>
              @if (outOf().get(p.id); as missing) {
                <span class="out-badge" title="Stock shows 0 – you can still sell if you have it">Out: {{ missing }}</span>
              }
              @if (qtyOf(p.id); as q) {
                <span class="qty">{{ q }}</span>
              }
            </button>
          }
        </div>
      </section>

      <aside class="cart">
        <div class="card">
        <div class="card-head">
          <h2>Order</h2>
          @if (cart().length) {
            <button class="btn ghost small" (click)="clear()">Clear</button>
          }
        </div>

        @for (line of cart(); track line.product.id) {
          <div class="cart-line">
            <div>
              <div style="font-weight: 600">{{ line.product.name }}</div>
              <div class="tiny">{{ line.product.priceCents | zar }} each</div>
            </div>
            <div class="qty-ctl">
              <button (click)="change(line.product.id, -1)" aria-label="Less">−</button>
              <span>{{ line.quantity }}</span>
              <button (click)="change(line.product.id, 1)" aria-label="More">+</button>
            </div>
            <div class="money" style="min-width: 76px; text-align: right; font-weight: 700">{{ line.product.priceCents * line.quantity | zar }}</div>
          </div>
        } @empty {
          <p class="empty">Tap a product to start an order</p>
        }

        @if (cart().length) {
          <div class="kv" style="margin-top: .75rem">
            <span>Subtotal</span><span>{{ subtotal() | zar }}</span>
            @if (discountCents()) {
              <span>Discount</span><span style="color: var(--bad)">−{{ discountCents() | zar }}</span>
            }
          </div>

          @if (showDiscount()) {
            <div class="grid-2" style="margin-top: .5rem; gap: .5rem">
              <label class="field"><span>Discount (R)</span><input inputmode="decimal" [ngModel]="discountText()" (ngModelChange)="discountText.set($event)" name="disc" /></label>
              <label class="field"><span>Reason</span><input [(ngModel)]="discountReason" name="discr" placeholder="e.g. loyal customer" /></label>
            </div>
            @if (!auth.isOwner()) {
              <p class="tiny">
                @if (maxDiscount() > 0) {
                  You may discount up to {{ maxDiscount() }}% without the owner.
                } @else {
                  Discounts need the owner – ask them to enable a limit in Settings.
                }
              </p>
            }
          } @else {
            <button class="btn ghost small" (click)="showDiscount.set(true)">+ Discount</button>
          }

          <div class="row between" style="margin: .75rem 0">
            <span class="muted">Total</span>
            <span class="total-big">{{ total() | zar }}</span>
          </div>

          <label class="field">
            <span>Note for the kitchen (optional)</span>
            <input [(ngModel)]="orderNote" name="note" maxlength="200" placeholder="e.g. no atchar, extra chips" />
          </label>

          <div class="pay-methods">
            @for (m of methods; track m.id) {
              <button [class.on]="method() === m.id" (click)="method.set(m.id)">{{ m.label }}</button>
            }
          </div>

          @if (method() === 'cash') {
            <label class="field" style="margin-top: .75rem">
              <span>Cash received</span>
              <input class="money-input" inputmode="decimal" [ngModel]="receivedText()" (ngModelChange)="receivedText.set($event)" name="recv" placeholder="0.00" />
            </label>
            <div class="quick-cash">
              <button class="btn small" (click)="receivedText.set(randString(total()))">Exact</button>
              @for (n of [50, 100, 200]; track n) {
                <button class="btn small" (click)="receivedText.set(n.toString())">R{{ n }}</button>
              }
            </div>
            @if (changeCents() !== null) {
              <div class="change-box"><span>Change</span><span>{{ changeCents()! | zar }}</span></div>
            }
          } @else {
            <label class="field" style="margin-top: .75rem">
              <span>{{ method() === 'card' ? 'Card slip number (optional)' : 'EFT reference (optional)' }}</span>
              <input [(ngModel)]="reference" name="ref" />
            </label>
            @if (method() === 'eft') {
              <p class="tiny">Only hand over the food once the EFT shows in the account or a proof of payment is confirmed.</p>
            }
          }

          <button class="btn ok block xl" style="margin-top: .75rem" [disabled]="!canPay()" (click)="pay()">
            {{ busy() ? 'Saving…' : 'Complete sale · ' + (total() | zar) }}
          </button>
          @if (retrying()) {
            <p class="tiny" style="margin-top: .5rem">Retrying is safe – this order will never be recorded twice.</p>
          }
        }

        @if (last(); as l) {
          <div class="alert" [class.ok]="l.receiptNo" [class.warn]="!l.receiptNo" style="margin-top: 1rem">
            {{ l.receiptNo ? 'Receipt #' + l.receiptNo + ' saved' : 'Saved on this phone (offline)' }} · {{ l.totalCents | zar }}
            @if (l.changeCents) {
              · <strong>Change {{ l.changeCents | zar }}</strong>
            }
            <div class="row" style="margin-top: .5rem">
              <button class="btn small" (click)="print(l)">🖨 Print receipt</button>
              <a class="btn small" [href]="whatsapp(l)" target="_blank" rel="noopener">WhatsApp receipt</a>
            </div>
          </div>
        }
        </div>
        <div class="card">
          <app-order-queue />
        </div>
      </aside>
    </div>
  `,
})
export class PosPage {
  protected readonly biz = inject(BusinessService);
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  /** category id → name, from the owner's category list */
  protected readonly labels = computed<Record<string, string | undefined>>(() =>
    Object.fromEntries(this.biz.settings().productCategories.map((c) => [c.id, c.name])),
  );
  protected readonly methods: { id: PaymentMethod; label: string }[] = [
    { id: 'cash', label: 'Cash' },
    { id: 'card', label: 'Card' },
    { id: 'eft', label: 'EFT' },
  ];

  protected readonly products = liveQuery<Product>(() => query(this.biz.col('products'), where('active', '==', true), orderBy('sortOrder')));
  private readonly recipes = liveQuery<Recipe>(() => this.biz.col('recipes'));
  private readonly stockItems = liveQuery<Ingredient>(() => query(this.biz.col('ingredients'), where('active', '==', true)));
  /** product id → names of its ingredients that are at 0 (still sellable – the app's stock may be missing a delivery) */
  protected readonly outOf = computed(() => {
    const empty = new Map(this.stockItems.data().filter((i) => i.currentQty <= 0).map((i) => [i.id, i.name]));
    const out = new Map<string, string>();
    if (!empty.size) return out;
    for (const r of this.recipes.data()) {
      const names = r.lines.filter((l) => l.quantity > 0 && empty.has(l.ingredientId)).map((l) => empty.get(l.ingredientId)!);
      if (names.length) out.set(r.productId, names.join(', '));
    }
    return out;
  });
  protected readonly category = signal<Product['category'] | 'all'>('all');
  /** tabs in the owner's order; only categories that have products for sale */
  protected readonly categories = computed(() => {
    const used = new Set(this.products.data().map((p) => p.category));
    const ordered = this.biz.settings().productCategories.map((c) => c.id).filter((id) => used.has(id));
    return [...ordered, ...[...used].filter((id) => !ordered.includes(id))];
  });
  protected readonly visible = computed(() => {
    const c = this.category();
    return this.products.data().filter((p) => c === 'all' || p.category === c);
  });

  protected readonly cart = signal<CartLine[]>([]);
  protected readonly method = signal<PaymentMethod>('cash');
  protected readonly receivedText = signal('');
  protected readonly showDiscount = signal(false);
  protected readonly busy = signal(false);
  protected readonly retrying = signal(false);
  protected readonly last = signal<Receipt | null>(null);
  protected readonly outbox = inject(OutboxService);
  protected readonly discountText = signal('');
  protected discountReason = '';
  protected reference = '';
  protected orderNote = '';
  private readonly orders = inject(OrdersService);
  private readonly confirm = inject(ConfirmService);
  /** Idempotency key for the current order; only replaced after the server confirms. */
  private saleId = newSaleId();

  protected readonly subtotal = computed(() => this.cart().reduce((s, l) => s + l.product.priceCents * l.quantity, 0));
  protected readonly discountCents = computed(() => {
    return this.showDiscount() ? Math.min(parseRandToCents(this.discountText() || '0') ?? 0, this.subtotal()) : 0;
  });
  protected readonly total = computed(() => this.subtotal() - this.discountCents());
  protected readonly receivedCents = computed(() => parseRandToCents(this.receivedText()));
  protected readonly changeCents = computed(() => {
    const r = this.receivedCents();
    return r !== null && r >= this.total() ? r - this.total() : null;
  });
  protected readonly maxDiscount = computed(() => this.biz.settings().maxEmployeeDiscountPercent);
  protected readonly canPay = computed(
    () => !this.busy() && !!this.biz.myOpenShift() && this.cart().length > 0 && (this.method() !== 'cash' || this.changeCents() !== null),
  );

  protected randString(cents: number) {
    return (cents / 100).toFixed(2);
  }

  qtyOf(id: string): number {
    return this.cart().find((l) => l.product.id === id)?.quantity ?? 0;
  }

  add(product: Product) {
    this.last.set(null);
    this.cart.update((lines) => {
      const found = lines.find((l) => l.product.id === product.id);
      return found ? lines.map((l) => (l === found ? { ...l, quantity: l.quantity + 1 } : l)) : [...lines, { product, quantity: 1 }];
    });
  }

  change(id: string, delta: number) {
    this.cart.update((lines) => lines.map((l) => (l.product.id === id ? { ...l, quantity: l.quantity + delta } : l)).filter((l) => l.quantity > 0));
  }

  clear() {
    this.cart.set([]);
    this.receivedText.set('');
    this.showDiscount.set(false);
    this.discountText.set('');
    this.discountReason = '';
    this.reference = '';
    this.orderNote = '';
    this.retrying.set(false);
    this.saleId = newSaleId();
  }

  async pay() {
    const discount = this.discountCents();
    if (discount > 0 && !this.discountReason.trim()) {
      this.toast.error('Give a reason for the discount');
      return;
    }
    if (discount > 0 && !this.auth.isOwner() && discountPercent(discount, this.subtotal()) > this.maxDiscount()) {
      this.toast.error(`Discounts above ${this.maxDiscount()}% need the owner`);
      return;
    }
    const request = {
      saleId: this.saleId,
      items: this.cart().map((l) => ({ productId: l.product.id, quantity: l.quantity })),
      discountCents: discount,
      discountReason: discount ? this.discountReason.trim() : undefined,
      payment: {
        method: this.method(),
        amountReceivedCents: this.method() === 'cash' ? (this.receivedCents() ?? undefined) : undefined,
        reference: this.reference.trim() || undefined,
      },
      soldAtMillis: Date.now(),
      expectedTotalCents: this.total(),
    };
    const receipt: Receipt = {
      receiptNo: null,
      at: request.soldAtMillis,
      cashier: this.auth.displayName(),
      lines: this.cart().map((l) => ({ name: l.product.name, quantity: l.quantity, lineTotalCents: l.product.priceCents * l.quantity })),
      subtotalCents: this.subtotal(),
      discountCents: discount,
      totalCents: this.total(),
      method: this.method(),
      receivedCents: request.payment.amountReceivedCents,
      changeCents: this.changeCents() ?? undefined,
    };
    // Extras and other non-kitchen items stay off the order queue.
    const ticketLines = this.cart()
      .filter((l) => inOrderQueue(l.product))
      .map((l) => ({ name: l.product.name, quantity: l.quantity }));
    this.busy.set(true);
    try {
      const res = await this.api.call('recordSale', request);
      // A duplicate means this sale (and its ticket) already exists – don't reset the ticket to "new".
      if (!res.duplicate && ticketLines.length) this.orders.create(request.saleId, ticketLines, this.orderNote, res.receiptNo);
      this.last.set({ ...receipt, receiptNo: res.receiptNo, totalCents: res.totalCents, changeCents: res.changeCents });
      if (res.duplicate) this.toast.info(`This order was already saved as receipt #${res.receiptNo}`);
      else this.toast.ok(res.changeCents ? `Saved – give change of R${(res.changeCents / 100).toFixed(2)}` : 'Sale saved');
      this.clear();
    } catch (err) {
      if (err instanceof ApiError && err.network) {
        // No internet: keep the sale on this phone; the outbox sends it (same saleId) when the network is back.
        this.outbox.enqueue(request);
        if (ticketLines.length) this.orders.create(request.saleId, ticketLines, this.orderNote, null);
        this.last.set(receipt);
        this.toast.info('No internet – sale saved on this phone and will be sent automatically');
        this.clear();
      } else {
        this.retrying.set(true);
        this.toast.error(err);
      }
    } finally {
      this.busy.set(false);
    }
  }

  print(r: Receipt) {
    printReceipt(r, this.biz.settings().businessName);
  }

  whatsapp(r: Receipt) {
    return whatsappReceiptUrl(r, this.biz.settings().businessName);
  }

  async discardFailed(saleId: string) {
    const ok = await this.confirm.ask({
      title: 'Discard this sale?',
      message: 'It will be removed from this phone and will NOT be in the records. Tell the owner so they can record it.',
      confirmText: 'Discard sale',
      tone: 'danger',
    });
    if (ok) this.outbox.discard(saleId);
  }
}
