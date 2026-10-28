import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';

function authMessage(err: unknown): string {
  const code = String((err as { code?: unknown }).code ?? '');
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Email or password is incorrect';
  if (code.includes('user-disabled')) return 'This account has been deactivated. Speak to the owner.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Wait a few minutes and try again.';
  if (code.includes('email-already-in-use')) return 'An account with this email already exists – sign in instead';
  if (code.includes('weak-password')) return 'Use a stronger password (at least 8 characters)';
  if (code.includes('network')) {
    return environment.useEmulators
      ? 'Cannot reach the local sign-in emulator. Start it with "npm run emulators" (needs Java 21+).'
      : 'No internet connection';
  }
  return (err as Error).message ?? 'Sign in failed';
}

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="auth-wrap">
      <form class="card auth-card" (ngSubmit)="submit()">
        <div class="logo">Kota<span>House</span></div>
        @if (envName !== 'prod') {
          <p class="env-pill" [class.dev]="envName === 'dev'" style="display: inline-block; margin-bottom: .5rem">
            {{ envName === 'local' ? 'LOCAL – emulators on this PC' : 'DEV – test shop, not real data' }}
          </p>
        }
        @if (auth.connectionError(); as problem) {
          <div class="alert bad small">{{ problem }}</div>
        }
        <p class="muted">{{ mode() === 'signin' ? 'Sign in to start selling or check on the shop.' : 'Create the owner account for your shop.' }}</p>

        @if (mode() === 'signup') {
          <label class="field"><span>Your name</span><input name="name" [(ngModel)]="name" required autocomplete="name" /></label>
        }
        <label class="field"><span>Email</span><input name="email" type="email" [(ngModel)]="email" required autocomplete="username" /></label>
        <label class="field">
          <span>Password</span>
          <input name="password" type="password" [(ngModel)]="password" required minlength="8"
            [autocomplete]="mode() === 'signin' ? 'current-password' : 'new-password'" />
        </label>

        <button class="btn primary block xl" [disabled]="busy()">{{ busy() ? 'Please wait…' : mode() === 'signin' ? 'Sign in' : 'Create owner account' }}</button>

        <div class="row between" style="margin-top: 1rem">
          @if (mode() === 'signin') {
            <button type="button" class="btn ghost small" (click)="forgot()">Forgot password?</button>
            <button type="button" class="btn ghost small" (click)="mode.set('signup')">New shop? Create owner account</button>
          } @else {
            <button type="button" class="btn ghost small" (click)="mode.set('signin')">I already have an account</button>
          }
        </div>
        <p class="tiny" style="margin-top: 1rem">Staff accounts are created by the owner from the Staff page.</p>
      </form>
    </div>
  `,
})
export class LoginPage {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected readonly mode = signal<'signin' | 'signup'>('signin');
  protected readonly envName = environment.name;
  protected readonly busy = signal(false);
  protected email = '';
  protected password = '';
  protected name = '';

  async submit() {
    if (!this.email || this.password.length < 8) {
      this.toast.error('Enter your email and a password of at least 8 characters');
      return;
    }
    this.busy.set(true);
    try {
      if (this.mode() === 'signup') {
        await this.auth.signUpOwner(this.email, this.password, this.name.trim() || 'Owner');
        await this.router.navigateByUrl('/setup');
      } else {
        await this.auth.signIn(this.email, this.password);
        await this.auth.ready;
        await this.router.navigateByUrl(this.auth.businessId() ? '/' : '/setup');
      }
    } catch (err) {
      this.toast.error(authMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  async forgot() {
    if (!this.email) {
      this.toast.info('Type your email first, then tap "Forgot password"');
      return;
    }
    try {
      await this.auth.resetPassword(this.email);
      this.toast.ok('Password reset email sent');
    } catch (err) {
      this.toast.error(authMessage(err));
    }
  }
}
