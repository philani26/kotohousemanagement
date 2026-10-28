import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { orderBy, query } from 'firebase/firestore';
import { Employee, Role } from '@shared/models';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ConfirmService } from '../../core/confirm.service';
import { ToastService } from '../../core/toast.service';
import { TsPipe } from '../../shared/pipes';

@Component({
  selector: 'app-employees',
  imports: [FormsModule, DatePipe, TsPipe],
  template: `
    <div class="page-head"><h1>Staff</h1></div>
    <div class="grid-2">
      <div class="card">
        <div class="list">
          @for (e of employees.data(); track e.uid) {
            <div class="list-item">
              <div class="main">
                <div class="row">
                  <span class="title">{{ e.displayName }}</span>
                  <span class="badge" [class.info]="e.role === 'owner'">{{ e.role === 'owner' ? 'Owner' : 'Cashier' }}</span>
                  @if (!e.active) {
                    <span class="badge bad">Deactivated</span>
                  }
                </div>
                <div class="tiny">{{ e.email }} {{ e.phone ? '· ' + e.phone : '' }} · since {{ e.createdAt | ts | date: 'd MMM yyyy' }}</div>
              </div>
              @if (e.uid !== auth.uid()) {
                <div class="stack" style="gap: .35rem">
                  <button class="btn small" (click)="toggle(e)">{{ e.active ? 'Deactivate' : 'Reactivate' }}</button>
                  <button class="btn small" (click)="resetFor.set(e)">New password</button>
                </div>
              }
            </div>
          }
        </div>
        <p class="tiny" style="margin-top: .5rem">Deactivating signs the person out everywhere immediately. Their sales history is kept.</p>
      </div>

      <form class="card" (ngSubmit)="create()">
        <h2>Add a staff member</h2>
        <label class="field"><span>Name</span><input name="n" [(ngModel)]="name" required /></label>
        <label class="field"><span>Email (used to sign in)</span><input name="e" type="email" [(ngModel)]="email" required /></label>
        <label class="field"><span>Phone</span><input name="p" type="tel" [(ngModel)]="phone" /></label>
        <label class="field"><span>Temporary password <span class="hint">– at least 8 characters, give it to them in person</span></span>
          <input name="pw" [(ngModel)]="password" required minlength="8" autocomplete="new-password" />
        </label>
        <label class="field">
          <span>Role</span>
          <select name="r" [(ngModel)]="role">
            <option value="employee">Cashier – sell, cash up, stock and expenses</option>
            <option value="owner">Owner – full access</option>
          </select>
        </label>
        <button class="btn primary block" [disabled]="busy()">Create login</button>
      </form>
    </div>

    @if (resetFor(); as e) {
      <div class="dialog-backdrop" (click)="resetFor.set(null)">
        <form class="dialog" (click)="$event.stopPropagation()" (ngSubmit)="reset(e)">
          <h2>New password for {{ e.displayName }}</h2>
          <label class="field"><span>New password</span><input name="np" [(ngModel)]="newPassword" minlength="8" required /></label>
          <div class="row">
            <button type="button" class="btn" (click)="resetFor.set(null)">Cancel</button>
            <button class="btn primary" [disabled]="busy()">Set password</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class EmployeesPage {
  protected readonly auth = inject(AuthService);
  private readonly biz = inject(BusinessService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly busy = signal(false);
  protected readonly resetFor = signal<Employee | null>(null);
  protected readonly employees = liveQuery<Employee>(() => query(this.biz.col('employees'), orderBy('displayName')));
  protected name = '';
  protected email = '';
  protected phone = '';
  protected password = '';
  protected role: Role = 'employee';
  protected newPassword = '';

  async create() {
    await this.run(async () => {
      await this.api.call('createEmployee', { displayName: this.name, email: this.email, phone: this.phone || undefined, password: this.password, role: this.role });
      this.toast.ok(`Login created for ${this.name}`);
      this.name = this.email = this.phone = this.password = '';
      this.role = 'employee';
    });
  }

  async toggle(e: Employee) {
    if (
      e.active &&
      !(await this.confirm.ask({
        title: `Deactivate ${e.displayName}?`,
        message: 'They will be signed out on every device immediately and cannot sign in again until you reactivate them. Their sales history is kept.',
        confirmText: 'Deactivate',
        tone: 'danger',
      }))
    ) {
      return;
    }
    await this.run(() => this.api.call('updateEmployee', { uid: e.uid, active: !e.active }).then(() => this.toast.ok('Updated')));
  }

  async reset(e: Employee) {
    await this.run(async () => {
      await this.api.call('updateEmployee', { uid: e.uid, password: this.newPassword });
      this.toast.ok('Password changed – they must sign in again');
      this.resetFor.set(null);
      this.newPassword = '';
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
