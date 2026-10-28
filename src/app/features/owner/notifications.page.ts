import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { limit, orderBy, query, updateDoc, writeBatch } from 'firebase/firestore';
import { AppNotification, Severity } from '@shared/models';
import { BusinessService } from '../../core/business.service';
import { FirebaseService } from '../../core/firebase.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { TsPipe } from '../../shared/pipes';

const ICON: Record<Severity, string> = { critical: '🔴', warning: '🟠', info: '🔵' };

/** Owner alerts. Tap one to see the full breakdown: amounts, people, times, reasons and what to do. */
@Component({
  selector: 'app-notifications',
  imports: [RouterLink, DatePipe, TsPipe],
  template: `
    <div class="page-head">
      <h1>Alerts</h1>
      <div class="seg">
        <button [class.on]="filter() === 'all'" (click)="filter.set('all')">All</button>
        <button [class.on]="filter() === 'unread'" (click)="filter.set('unread')">Unread ({{ unreadCount() }})</button>
        <button [class.on]="filter() === 'critical'" (click)="filter.set('critical')">Critical</button>
      </div>
      <button class="btn small" (click)="markAll()" [disabled]="!unreadCount()">Mark all read</button>
    </div>
    <p class="muted small">Tap an alert to see the details. Alert thresholds can be changed in Settings to avoid unnecessary alerts.</p>

    @for (n of visible(); track n.id) {
      <article class="card alert-card" [class.unread]="!n.read" [attr.data-severity]="n.severity">
        <button class="alert-head" (click)="toggle(n)" [attr.aria-expanded]="open() === n.id">
          <span class="alert-icon">{{ icon[n.severity] }}</span>
          <span class="main">
            <span class="title">{{ n.title }}</span>
            <span class="small muted">{{ n.message }}</span>
            <span class="tiny">
              {{ n.createdAt | ts | date: 'EEE d MMM, HH:mm' }}
              @if (n.actorName) {
                · {{ n.actorName }}
              }
            </span>
          </span>
          <span class="chev">{{ open() === n.id ? '▴' : '▾' }}</span>
        </button>

        @if (open() === n.id) {
          <div class="alert-body">
            @if (n.details?.length) {
              <dl class="alert-details">
                @for (d of n.details; track $index) {
                  <div [class]="'detail ' + (d.tone ?? '')" [class.sum]="d.label.startsWith('=')">
                    <dt>{{ d.label }}</dt>
                    <dd>{{ d.value }}</dd>
                  </div>
                }
              </dl>
            } @else {
              <p class="small muted">No further details were recorded for this alert.</p>
            }
            @if (n.action) {
              <div class="alert info small" style="margin: .75rem 0 0"><strong>What to do:</strong> {{ n.action }}</div>
            }
            <div class="row" style="margin-top: .75rem">
              @if (n.link) {
                <a class="btn small primary" [routerLink]="n.link">{{ linkLabel(n.link) }}</a>
              }
              @if (!n.read) {
                <button class="btn small" (click)="read(n)">Mark read</button>
              }
            </div>
          </div>
        }
      </article>
    } @empty {
      <div class="card empty">{{ list.loading() ? 'Loading…' : 'No alerts' }}</div>
    }
  `,
})
export class NotificationsPage {
  private readonly biz = inject(BusinessService);
  private readonly fb = inject(FirebaseService);
  private readonly toast = inject(ToastService);
  protected readonly icon = ICON;
  protected readonly open = signal<string | null>(null);
  protected readonly filter = signal<'all' | 'unread' | 'critical'>('all');

  protected readonly list = liveQuery<AppNotification>(() => query(this.biz.col('notifications'), orderBy('createdAt', 'desc'), limit(150)));
  protected readonly unreadCount = computed(() => this.list.data().filter((n) => !n.read).length);
  protected readonly visible = computed(() => {
    const f = this.filter();
    return this.list.data().filter((n) => f === 'all' || (f === 'unread' ? !n.read : n.severity === 'critical'));
  });

  toggle(n: AppNotification) {
    const opening = this.open() !== n.id;
    this.open.set(opening ? n.id : null);
    if (opening) this.read(n); // opening an alert counts as reading it
  }

  read(n: AppNotification) {
    if (!n.read) updateDoc(this.biz.docRef('notifications', n.id), { read: true }).catch((e) => this.toast.error(e));
  }

  linkLabel(link: string) {
    const labels: Record<string, string> = {
      '/cash': 'Open cash-ups',
      '/approvals': 'Open approvals',
      '/stock': 'Open stock',
      '/sales': 'Open sales',
      '/dashboard': 'Open dashboard',
    };
    return labels[link] ?? 'Open';
  }

  async markAll() {
    const batch = writeBatch(this.fb.db);
    this.list.data().filter((n) => !n.read).forEach((n) => batch.update(this.biz.docRef('notifications', n.id), { read: true }));
    await batch.commit().catch((e) => this.toast.error(e));
  }
}
