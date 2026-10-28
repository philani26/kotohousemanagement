import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { limit, orderBy, query, where } from 'firebase/firestore';
import { AuditLog } from '@shared/models';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { TsPipe } from '../../shared/pipes';

/** Read-only, tamper-proof activity trail written only by backend functions. */
@Component({
  selector: 'app-audit',
  imports: [FormsModule, DatePipe, JsonPipe, TsPipe],
  template: `
    <div class="page-head">
      <h1>Activity log</h1>
      <input type="date" [ngModel]="day()" (ngModelChange)="day.set($event)" style="width: auto" />
      <input placeholder="Filter: name, action…" [ngModel]="filter()" (ngModelChange)="filter.set($event)" style="max-width: 240px" />
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            @for (a of visible(); track a.id) {
              <tr>
                <td class="small">{{ a.at | ts | date: 'HH:mm:ss' }}</td>
                <td>{{ a.actorName }}<div class="tiny">{{ a.actorRole }}</div></td>
                <td><span class="badge" [class.warn]="isSensitive(a.action)">{{ a.action }}</span></td>
                <td class="tiny" style="max-width: 420px; word-break: break-word">{{ a.details | json }}</td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="empty">{{ logs.loading() ? 'Loading…' : 'No activity on this day' }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class AuditPage {
  private readonly biz = inject(BusinessService);
  protected readonly day = signal(this.biz.today());
  protected readonly filter = signal('');
  protected readonly logs = liveQuery<AuditLog>(() =>
    query(this.biz.col('auditLogs'), where('dayKey', '==', this.day()), orderBy('at', 'desc'), limit(500)),
  );
  protected readonly visible = computed(() => {
    const f = this.filter().toLowerCase().trim();
    return f ? this.logs.data().filter((a) => `${a.actorName} ${a.action} ${JSON.stringify(a.details)}`.toLowerCase().includes(f)) : this.logs.data();
  });

  isSensitive(action: string) {
    return /refund|discount|adjust|payout|price|products\.|employee|rejected|settings/i.test(action);
  }
}
