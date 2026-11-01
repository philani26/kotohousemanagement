import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { limit, orderBy, query } from 'firebase/firestore';
import { TimestampLike } from '@shared/models';
import { waPhone } from '@shared/domain';
import { ApiService } from '../../core/api.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { TsPipe } from '../../shared/pipes';

interface WaMessage {
  id: string;
  direction: 'in' | 'out';
  waId: string;
  name?: string;
  text: string;
  status?: 'sent' | 'dry-run' | 'failed';
  error?: string;
  at: TimestampLike;
}

/** Owner: the shop's WhatsApp number, ordering on/off, and the conversation log. */
@Component({
  selector: 'app-whatsapp',
  imports: [FormsModule, DatePipe, TsPipe],
  template: `
    <div class="page-head">
      <h1>💬 WhatsApp</h1>
      <span class="badge" [class.ok]="wa().ordering">{{ wa().ordering ? 'Taking orders' : 'Off' }}</span>
    </div>

    <div class="grid-2">
      <form class="card" (ngSubmit)="save()">
        <h2>Your shop's WhatsApp number</h2>
        <p class="small muted">Customers message this number to see the menu and order. They get a message when their order is ready to collect.</p>

        <label class="field">
          <span>WhatsApp number</span>
          <input name="num" type="tel" [(ngModel)]="displayNumber" placeholder="082 123 4567" required />
        </label>
        <label class="field">
          <span>Phone number ID <span class="hint">– from Meta: WhatsApp › API setup (a long number)</span></span>
          <input name="pid" inputmode="numeric" [(ngModel)]="phoneNumberId" placeholder="e.g. 109876543210987" />
        </label>
        <label class="check"><input type="checkbox" name="on" [(ngModel)]="ordering" /> Take orders on WhatsApp</label>

        <div class="row" style="margin-top: .75rem">
          <button class="btn primary" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save' }}</button>
          @if (wa().displayNumber) {
            <a class="btn" [href]="'https://wa.me/' + (waLink() ?? '')" target="_blank" rel="noopener">Open chat</a>
          }
        </div>

        @if (wa().displayNumber) {
          <div class="alert info small" style="margin-top: 1rem">
            Share with customers: <strong>{{ wa().displayNumber }}</strong>
            @if (waLink()) {
              · <span style="word-break: break-all">wa.me/{{ waLink() }}</span>
            }
          </div>
        }
      </form>

      <div class="card">
        <h2>Setting up the number</h2>
        <ol class="small" style="padding-left: 1.1rem; margin: 0">
          <li>Use a number that is <strong>not</strong> already on the WhatsApp app (e.g. a new SIM for the shop).</li>
          <li>Register it on Meta's WhatsApp Business Platform and copy its <strong>Phone number ID</strong>.</li>
          <li>Your developer adds the Meta keys to the server (see docs/WHATSAPP.md).</li>
          <li>Enter the number and the Phone number ID here, tick <em>Take orders</em>, and Save.</li>
        </ol>
        <p class="tiny" style="margin-top: .75rem">
          Until the Meta keys are on the server, the bot still works but replies are only recorded below as <em>not sent – dry run</em>.
        </p>
      </div>
    </div>

    <div class="card">
      <h2>Latest messages</h2>
      <div class="list">
        @for (m of messages.data(); track m.id) {
          <div class="list-item">
            <span>{{ m.direction === 'in' ? '⬅️' : '➡️' }}</span>
            <div class="main">
              <div class="tiny">
                {{ m.direction === 'in' ? (m.name || m.waId) : 'To ' + m.waId }} · {{ m.at | ts | date: 'd MMM HH:mm' }}
                @if (m.status === 'dry-run') {
                  <span class="badge">not sent – dry run</span>
                } @else if (m.status === 'failed') {
                  <span class="badge bad" [title]="m.error ?? ''">failed</span>
                }
              </div>
              <div class="small" style="white-space: pre-line">{{ m.text }}</div>
            </div>
          </div>
        } @empty {
          <p class="empty small">No WhatsApp messages yet</p>
        }
      </div>
    </div>
  `,
})
export class WhatsappPage {
  private readonly biz = inject(BusinessService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly wa = computed(() => this.biz.settings().whatsapp);
  protected readonly waLink = computed(() => waPhone(this.wa().displayNumber));
  protected readonly busy = signal(false);
  protected displayNumber = '';
  protected phoneNumberId = '';
  protected ordering = false;
  private loaded = false;

  protected readonly messages = liveQuery<WaMessage>(() => query(this.biz.col('whatsappMessages'), orderBy('at', 'desc'), limit(30)));

  constructor() {
    // fill the form once the saved settings arrive
    effect(() => {
      const s = this.biz.settings();
      if (this.loaded || !s.updatedAt) return;
      this.loaded = true;
      this.displayNumber = s.whatsapp.displayNumber;
      this.phoneNumberId = s.whatsapp.phoneNumberId;
      this.ordering = s.whatsapp.ordering;
    });
  }

  async save() {
    if (this.displayNumber.trim() && !waPhone(this.displayNumber)) {
      return this.toast.error('Enter a South African number, e.g. 082 123 4567 or +27 82 123 4567');
    }
    this.busy.set(true);
    try {
      await this.api.call('linkWhatsapp', {
        ordering: this.ordering,
        phoneNumberId: this.phoneNumberId.trim(),
        displayNumber: this.displayNumber.trim(),
      });
      this.toast.ok(this.ordering ? 'Saved – WhatsApp ordering is on' : 'WhatsApp number saved');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
