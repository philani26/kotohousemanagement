import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { ConfirmService } from '../core/confirm.service';

@Component({
  selector: 'app-confirm-dialog',
  host: { '(document:keydown.escape)': 'confirm.current() && confirm.answer(false)' },
  template: `
    @if (confirm.current(); as c) {
      <div class="dialog-backdrop" (click)="confirm.answer(false)">
        <div class="dialog confirm-dialog" role="alertdialog" aria-modal="true" [attr.aria-label]="c.title" (click)="$event.stopPropagation()">
          <h2>{{ c.title }}</h2>
          @if (c.message) {
            <p class="muted">{{ c.message }}</p>
          }
          @if (c.details?.length) {
            <div class="confirm-summary">
              @for (d of c.details; track d.label) {
                <div class="row between" [class.strong]="d.strong">
                  <span>{{ d.label }}</span><span class="money">{{ d.value }}</span>
                </div>
              }
            </div>
          }
          @if (c.warning) {
            <p class="alert warn small">{{ c.warning }}</p>
          }
          <div class="confirm-actions">
            <button type="button" class="btn" (click)="confirm.answer(false)">{{ c.cancelText ?? 'Cancel' }}</button>
            <button #ok type="button" [class]="'btn ' + (c.tone ?? 'primary')" (click)="confirm.answer(true)">
              {{ c.confirmText ?? 'OK' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConfirmDialogComponent {
  protected readonly confirm = inject(ConfirmService);
  private readonly ok = viewChild<ElementRef<HTMLButtonElement>>('ok');

  constructor() {
    // Focus the main button so Enter confirms and Esc cancels, like a native dialog.
    effect(() => this.ok()?.nativeElement.focus());
  }
}
