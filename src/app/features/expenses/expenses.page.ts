import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { limit, orderBy, query, where } from 'firebase/firestore';
import { EXPENSE_INVENTORY_CATEGORY, Expense } from '@shared/models';
import { parseRandToCents } from '@shared/money';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ConfirmService } from '../../core/confirm.service';
import { ToastService } from '../../core/toast.service';
import { UploadService } from '../../core/upload.service';
import { TsPipe, ZarPipe } from '../../shared/pipes';

@Component({
  selector: 'app-expenses',
  imports: [FormsModule, DatePipe, ZarPipe, TsPipe],
  template: `
    <div class="page-head"><h1>Expenses</h1></div>

    <div class="grid-2">
      <form class="card" (ngSubmit)="submit()">
        <h2>Record an expense</h2>
        <label class="field"><span>Amount (R)</span><input class="money-input" inputmode="decimal" name="amt" [(ngModel)]="amountText" required /></label>
        <label class="field">
          <span>Category</span>
          <select name="cat" [(ngModel)]="category" required>
            @for (c of biz.settings().expenseCategories; track c) {
              <option [value]="c">{{ c }}</option>
            }
          </select>
        </label>
        @if (category === inventoryCategory) {
          <p class="alert info small">Buying bread, polony, chips etc.? Use <strong>Stock › Delivery</strong> instead so the stock levels go up.</p>
        }
        <label class="field"><span>What was it for?</span><input name="desc" [(ngModel)]="description" required placeholder="e.g. 9kg gas refill" /></label>
        <label class="field"><span>Date</span><input type="date" name="date" [(ngModel)]="date" [max]="biz.today()" required /></label>
        <label class="check"><input type="checkbox" name="till" [(ngModel)]="paidFromTill" /> Paid with cash from the till</label>
        <label class="field" style="margin-top: .5rem">
          <span>Receipt photo <span class="hint">– strongly recommended</span></span>
          <input type="file" accept="image/*,application/pdf" capture="environment" (change)="pick($event)" />
        </label>
        <button class="btn primary block" [disabled]="busy()">{{ busy() ? 'Saving…' : auth.isOwner() ? 'Save expense' : 'Submit for approval' }}</button>
      </form>

      <div class="card">
        <h2>{{ auth.isOwner() ? 'All expenses' : 'My expenses' }}</h2>
        <div class="list">
          @for (e of expenses.data(); track e.id) {
            <div class="list-item">
              <div class="main">
                <div class="row">
                  <span class="title">{{ e.amountCents | zar }}</span>
                  <span class="badge" [class.ok]="e.status === 'approved'" [class.bad]="e.status === 'rejected'" [class.warn]="e.status === 'submitted'">
                    {{ e.status === 'submitted' ? 'Waiting for owner' : e.status }}
                  </span>
                  @if (e.paidFromTill) {
                    <span class="badge">Till cash</span>
                  }
                </div>
                <div class="small">{{ e.category }} – {{ e.description }}</div>
                <div class="tiny">{{ e.date }} · {{ e.submittedByName }} · {{ e.createdAt | ts | date: 'd MMM HH:mm' }}</div>
                @if (e.decision?.note) {
                  <div class="tiny">Owner: {{ e.decision!.note }}</div>
                }
              </div>
              @if (e.receiptPath) {
                <button class="btn small" (click)="openReceipt(e.receiptPath!)">Receipt</button>
              }
            </div>
          } @empty {
            <p class="empty">{{ expenses.loading() ? 'Loading…' : 'No expenses yet' }}</p>
          }
        </div>
      </div>
    </div>
  `,
})
export class ExpensesPage {
  protected readonly biz = inject(BusinessService);
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly upload = inject(UploadService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly inventoryCategory = EXPENSE_INVENTORY_CATEGORY;
  protected readonly busy = signal(false);
  protected amountText = '';
  protected category = this.biz.settings().expenseCategories[1] ?? '';
  protected description = '';
  protected date = this.biz.today();
  protected paidFromTill = true;
  private file: File | null = null;
  private fileInput: HTMLInputElement | null = null;

  protected readonly expenses = liveQuery<Expense>(() =>
    this.auth.isOwner()
      ? query(this.biz.col('expenses'), orderBy('createdAt', 'desc'), limit(100))
      : query(this.biz.col('expenses'), where('submittedBy', '==', this.auth.uid()), orderBy('createdAt', 'desc'), limit(50)),
  );

  pick(event: Event) {
    this.fileInput = event.target as HTMLInputElement;
    this.file = this.fileInput.files?.[0] ?? null;
  }

  async submit() {
    const amountCents = parseRandToCents(this.amountText);
    if (!amountCents) return this.toast.error('Enter the amount');
    if (
      !this.file &&
      !(await this.confirm.ask({
        title: 'No receipt attached',
        message: 'Expenses without a receipt photo are harder for the owner to approve. Submit anyway?',
        confirmText: 'Submit without receipt',
        cancelText: 'Add a receipt',
      }))
    ) {
      return;
    }
    this.busy.set(true);
    try {
      const receiptPath = this.file ? await this.upload.uploadReceipt(this.file) : undefined;
      await this.api.call('submitExpense', {
        amountCents,
        category: this.category,
        description: this.description,
        date: this.date,
        paidFromTill: this.paidFromTill,
        receiptPath,
      });
      this.toast.ok(this.auth.isOwner() ? 'Expense saved' : 'Sent to the owner for approval');
      this.amountText = '';
      this.description = '';
      this.file = null;
      if (this.fileInput) this.fileInput.value = '';
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async openReceipt(path: string) {
    try {
      window.open(await this.upload.url(path), '_blank', 'noopener');
    } catch (err) {
      this.toast.error(err);
    }
  }
}
