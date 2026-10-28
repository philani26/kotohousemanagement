import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { limit, query, where } from 'firebase/firestore';
import { AppNotification } from '@shared/models';
import { AuthService } from '../core/auth.service';
import { BusinessService } from '../core/business.service';
import { liveQuery } from '../core/live';
import { OutboxService } from '../core/outbox.service';
import { ToastService } from '../core/toast.service';
import { NavItem, OWNER_NAV, STAFF_NAV } from './nav';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="app">
      <header class="topbar">
        @if (auth.isOwner()) {
          <a class="brand" routerLink="/shops" style="color: inherit; text-decoration: none" title="Switch or add a shop">
            <span class="dot"></span>{{ biz.settings().businessName }}
            @if (shopCount() > 1) {
              <span class="tiny" style="color: #fff9">▾ {{ shopCount() }} shops</span>
            }
          </a>
        } @else {
          <div class="brand"><span class="dot"></span>{{ biz.settings().businessName }}</div>
        }
        @if (envName !== 'prod') {
          <span class="env-pill" [class.dev]="envName === 'dev'" title="Not the real shop – test data only">
            {{ envName === 'local' ? 'LOCAL' : 'DEV · TEST' }}
          </span>
        }
        <span class="shift-pill" [class.open]="biz.openShift()">
          {{ biz.openShift() ? 'Open · ' + biz.openShift()!.employeeName : 'Closed' }}
        </span>
        @if (outbox.count() || !outbox.online()) {
          <span class="shift-pill" style="background: var(--warn)" title="Sales are saved on this phone and sent when the internet is back">
            Offline{{ outbox.count() ? ' · ' + outbox.count() + ' to send' : '' }}
          </span>
        }
        <span class="spacer"></span>
        @if (auth.isOwner()) {
          <a class="icon-btn" routerLink="/notifications" [attr.aria-label]="unread() + ' unread alerts'" style="text-decoration: none">
            🔔
            @if (unread()) {
              <sup class="badge bad">{{ unread() }}</sup>
            }
          </a>
        }
        <div class="who">
          {{ auth.displayName() }}<br /><span class="tiny" style="color: #fff9">{{ auth.isOwner() ? 'Owner' : 'Staff' }}</span>
        </div>
        <button class="icon-btn" (click)="signOut()" [style.opacity]="mustCloseShift() ? 0.4 : 1"
          [title]="mustCloseShift() ? 'Close your shift before signing out' : 'Sign out'" aria-label="Sign out">⎋</button>
      </header>

      <nav class="sidenav" aria-label="Main">
        @for (group of groups(); track group.name) {
          <div class="group">{{ group.name }}</div>
          @for (item of group.items; track item.path) {
            <a [routerLink]="item.path" routerLinkActive="active">
              <span>{{ item.ico }}</span>{{ item.label }}
              @if (item.path === '/approvals' && pending()) {
                <span class="badge warn">{{ pending() }}</span>
              }
              @if (item.path === '/orders' && activeOrders()) {
                <span class="badge info">{{ activeOrders() }}</span>
              }
            </a>
          }
        }
      </nav>

      <main class="content">
        <router-outlet />
      </main>

      <nav class="bottomnav" aria-label="Main">
        @for (item of bottom(); track item.path) {
          <a [routerLink]="item.path" routerLinkActive="active" style="position: relative">
            <span class="ico">{{ item.ico }}</span>{{ item.label }}
            @if (item.path === '/orders' && activeOrders()) {
              <span class="badge info" style="position: absolute; top: 2px; right: 18%">{{ activeOrders() }}</span>
            }
          </a>
        }
        <a href="" (click)="$event.preventDefault(); more.set(true)"><span class="ico">☰</span>More</a>
      </nav>

      @if (more()) {
        <div class="more-menu" (click)="more.set(false)">
          <div class="sheet" (click)="$event.stopPropagation()">
            @for (item of allItems(); track item.path) {
              <a [routerLink]="item.path" (click)="more.set(false)"><span class="ico">{{ item.ico }}</span>{{ item.label }}</a>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class ShellComponent {
  protected readonly auth = inject(AuthService);
  protected readonly biz = inject(BusinessService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected readonly outbox = inject(OutboxService);
  protected readonly more = signal(false);
  protected readonly envName = environment.name;
  protected readonly shopCount = computed(() => Object.keys(this.auth.memberships()).length);

  protected readonly allItems = computed<NavItem[]>(() => (this.auth.isOwner() ? [...OWNER_NAV, ...STAFF_NAV] : STAFF_NAV));
  protected readonly groups = computed(() => {
    const items = this.allItems();
    return (['Owner', 'Shop', 'Setup'] as const)
      .map((name) => ({ name, items: items.filter((i) => i.group === name) }))
      .filter((g) => g.items.length);
  });
  protected readonly bottom = computed(() =>
    this.auth.isOwner()
      ? [OWNER_NAV[0], OWNER_NAV[1], STAFF_NAV[0], STAFF_NAV[1]]
      : [STAFF_NAV[0], STAFF_NAV[1], STAFF_NAV[2], STAFF_NAV[3]], // Sell, Orders, Shift, Sales
  );

  private readonly unreadList = liveQuery<AppNotification>(() =>
    this.auth.isOwner() ? query(this.biz.col('notifications'), where('read', '==', false), limit(50)) : null,
  );
  protected readonly unread = computed(() => this.unreadList.data().length);
  private readonly pendingList = liveQuery<{ id: string }>(() =>
    this.auth.isOwner() ? query(this.biz.col('approvals'), where('status', '==', 'pending'), limit(50)) : null,
  );
  protected readonly pending = computed(() => this.pendingList.data().length);
  private readonly todaysOrders = liveQuery<{ id: string; status: string }>(() =>
    this.auth.businessId() ? query(this.biz.col('orders'), where('dayKey', '==', this.biz.today())) : null,
  );
  /** orders paid but not yet collected */
  protected readonly activeOrders = computed(() => this.todaysOrders.data().filter((o) => o.status !== 'collected').length);

  /** A cashier must cash up and close their shift before signing out. */
  protected readonly mustCloseShift = computed(() => !this.auth.isOwner() && this.biz.openShift()?.employeeId === this.auth.uid());

  async signOut() {
    if (this.outbox.count()) {
      this.toast.error('Sales saved offline are still on this phone. Connect to the internet so they send before signing out.');
      return;
    }
    if (this.mustCloseShift()) {
      this.toast.error('Close your shift before signing out: count the cash and submit the cash-up.');
      await this.router.navigateByUrl('/shift');
      return;
    }
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
