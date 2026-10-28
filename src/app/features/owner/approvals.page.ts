import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { getDoc, limit, orderBy, query, where } from 'firebase/firestore';
import { Approval, Expense } from '@shared/models';
import { ApiService } from '../../core/api.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { UploadService } from '../../core/upload.service';
import { TsPipe, ZarPipe } from '../../shared/pipes';

const TYPE_LABELS: Record<Approval['type'], string> = { refund: 'Refund', expense: 'Expense', stockAdjustment: 'Stock correction' };

@Component({
  selector: 'app-approvals',
  imports: [FormsModule, DatePipe, ZarPipe, TsPipe],
  template: `
    <div class="page-head"><h1>Approvals</h1></div>
    <div class="tabs">
      <button [class.on]="tab() === 'pending'" (click)="tab.set('pending')">Waiting ({{ pending.data().length }})</button>
      <button [class.on]="tab() === 'history'" (click)="tab.set('history')">Decided</button>
    </div>

    @if (tab() === 'pending') {
      @for (a of pending.data(); track a.id) {
        <div class="card">
          <div class="row between">
            <div class="row">
              <span class="badge warn">{{ label(a.type) }}</span>
              <strong class="money">{{ a.amountCents | zar }}</strong>
            </div>
            <span class="tiny">{{ a.requestedAt | ts | date: 'EEE d MMM HH:mm' }}</span>
          </div>
          <p style="margin: .5rem 0">{{ a.summary }}</p>
          <p class="tiny">Requested by {{ a.requestedByName }}</p>
          @if (a.type === 'expense' && a.payload['hasReceipt']) {
            <button class="btn small" (click)="receipt(a)">View receipt</button>
          } @else if (a.type === 'expense') {
            <p class="badge bad">No receipt</p>
          }
          @if (a.type === 'refund' && a.payload['method'] === 'cash') {
            <p class="tiny">Approving pays the cash back out of the till that is open now.</p>
          }
          <label class="field" style="margin-top: .75rem"><span>Note (required to reject)</span><input [(ngModel)]="notes[a.id]" [name]="'n' + a.id" /></label>
          <div class="row">
            <button class="btn ok" [disabled]="busy() === a.id" (click)="decide(a, true)">Approve</button>
            <button class="btn danger" [disabled]="busy() === a.id" (click)="decide(a, false)">Reject</button>
          </div>
        </div>
      } @empty {
        <div class="card empty">{{ pending.loading() ? 'Loading…' : 'Nothing waiting for you. 👍' }}</div>
      }
    } @else {
      <div class="card">
        <div class="list">
          @for (a of history.data(); track a.id) {
            <div class="list-item">
              <div class="main">
                <div class="row">
                  <span class="badge" [class.ok]="a.status === 'approved'" [class.bad]="a.status === 'rejected'">{{ a.status }}</span>
                  <span class="title">{{ label(a.type) }} · {{ a.amountCents | zar }}</span>
                </div>
                <div class="small">{{ a.summary }}</div>
                <div class="tiny">
                  {{ a.requestedByName }} → {{ a.decidedByName }} · {{ a.decidedAt | ts | date: 'd MMM HH:mm' }}
                  @if (a.note) {
                    · “{{ a.note }}”
                  }
                </div>
              </div>
            </div>
          } @empty {
            <p class="empty">No decisions yet</p>
          }
        </div>
      </div>
    }
  `,
})
export class ApprovalsPage {
  private readonly biz = inject(BusinessService);
  private readonly api = inject(ApiService);
  private readonly upload = inject(UploadService);
  private readonly toast = inject(ToastService);
  protected readonly tab = signal<'pending' | 'history'>('pending');
  protected readonly busy = signal<string | null>(null);
  protected notes: Record<string, string> = {};

  protected readonly pending = liveQuery<Approval>(() =>
    query(this.biz.col('approvals'), where('status', '==', 'pending'), orderBy('requestedAt', 'desc'), limit(100)),
  );
  protected readonly history = liveQuery<Approval>(() =>
    this.tab() === 'history'
      ? query(this.biz.col('approvals'), where('status', 'in', ['approved', 'rejected']), orderBy('requestedAt', 'desc'), limit(100))
      : null,
  );

  label(t: Approval['type']) {
    return TYPE_LABELS[t];
  }

  async decide(a: Approval, approve: boolean) {
    const note = this.notes[a.id]?.trim();
    if (!approve && !note) return this.toast.error('Add a note explaining why you are rejecting');
    this.busy.set(a.id);
    try {
      await this.api.call('decideApproval', { approvalId: a.id, approve, note: note || undefined });
      this.toast.ok(approve ? 'Approved' : 'Rejected');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(null);
    }
  }

  async receipt(a: Approval) {
    try {
      const expense = (await getDoc(this.biz.docRef('expenses', a.refId))).data() as Expense | undefined;
      if (!expense?.receiptPath) throw new Error('No receipt found');
      window.open(await this.upload.url(expense.receiptPath), '_blank', 'noopener');
    } catch (err) {
      this.toast.error(err);
    }
  }
}
