import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { doc, orderBy, query, setDoc, updateDoc } from 'firebase/firestore';
import { Ingredient, IngredientUnit, Supplier } from '@shared/models';
import { parseRandToCents } from '@shared/money';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { ZarPipe } from '../../shared/pipes';

const UNITS: IngredientUnit[] = ['each', 'kg', 'g', 'litre', 'ml', 'pack', 'loaf', 'slice'];

interface IngDraft {
  id: string | null;
  name: string;
  unit: IngredientUnit;
  opening: number | null;
  cost: string;
  reorder: number | null;
  supplierId: string;
  active: boolean;
  countDaily: boolean;
}

interface SupDraft {
  id: string | null;
  name: string;
  phone: string;
  email: string;
  notes: string;
  active: boolean;
}

@Component({
  selector: 'app-ingredients',
  imports: [FormsModule, DecimalPipe, ZarPipe],
  template: `
    <div class="page-head">
      <h1>Ingredients</h1>
      <button class="btn primary" (click)="editIng(null)">+ Ingredient</button>
      <button class="btn" (click)="editSup(null)">+ Supplier</button>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Ingredient</th><th class="r">Stock</th><th class="r">Cost/unit</th><th>Supplier</th><th></th></tr></thead>
            <tbody>
              @for (i of ingredients.data(); track i.id) {
                <tr [class.dim]="!i.active">
                  <td>{{ i.name }}@if (i.countDaily) {<span class="badge warn" style="margin-left: .35rem">daily count</span>}<div class="tiny">reorder at {{ i.reorderLevel }} {{ i.unit }}</div></td>
                  <td class="r">{{ (i.currentQty > 0 ? i.currentQty : 0) | number: '1.0-2' }} {{ i.unit }}</td>
                  <td class="r">{{ i.unitCostCents | zar }}</td>
                  <td class="small">{{ supplierName(i.supplierId) }}</td>
                  <td><button class="btn small" (click)="editIng(i)">Edit</button></td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="empty">No ingredients yet</td></tr>
              }
            </tbody>
          </table>
        </div>
        <p class="tiny" style="margin-top: .5rem">Stock levels change only through deliveries, sales, wastage and approved corrections, so every change is traceable.</p>
      </div>

      <div>
        @if (ing(); as d) {
          <form class="card" (ngSubmit)="saveIng()">
            <h2>{{ d.id ? 'Edit ' + d.name : 'New ingredient' }}</h2>
            <div class="form-grid">
              <label class="field full"><span>Name</span><input name="n" [(ngModel)]="d.name" required /></label>
              <label class="field">
                <span>Unit</span>
                <select name="u" [(ngModel)]="d.unit" [disabled]="!!d.id">
                  @for (u of units; track u) {
                    <option [value]="u">{{ u }}</option>
                  }
                </select>
              </label>
              <label class="field"><span>Cost per {{ d.unit }} (R)</span><input name="c" inputmode="decimal" [(ngModel)]="d.cost" required /></label>
              @if (!d.id) {
                <label class="field"><span>Opening stock</span><input name="o" type="number" step="any" min="0" [(ngModel)]="d.opening" /></label>
              }
              <label class="field"><span>Reorder level</span><input name="r" type="number" step="any" min="0" [(ngModel)]="d.reorder" /></label>
              <label class="field full">
                <span>Supplier</span>
                <select name="s" [(ngModel)]="d.supplierId">
                  <option value="">—</option>
                  @for (s of suppliers.data(); track s.id) {
                    <option [value]="s.id">{{ s.name }}</option>
                  }
                </select>
              </label>
            </div>
            <label class="check"><input type="checkbox" name="a" [(ngModel)]="d.active" /> Active</label>
            <label class="check"><input type="checkbox" name="cd" [(ngModel)]="d.countDaily" /> Must be counted at every close <span class="tiny">(high-theft items: Russians, cheese, drinks)</span></label>
            <div class="row" style="margin-top: .75rem">
              <button type="button" class="btn" (click)="ing.set(null)">Cancel</button>
              <button class="btn primary" [disabled]="busy()">Save</button>
            </div>
          </form>
        }

        @if (sup(); as s) {
          <form class="card" (ngSubmit)="saveSup()">
            <h2>{{ s.id ? 'Edit supplier' : 'New supplier' }}</h2>
            <label class="field"><span>Name</span><input name="sn" [(ngModel)]="s.name" required /></label>
            <label class="field"><span>Phone</span><input name="sp" type="tel" [(ngModel)]="s.phone" /></label>
            <label class="field"><span>Email</span><input name="se" type="email" [(ngModel)]="s.email" /></label>
            <label class="field"><span>Notes</span><textarea name="sno" [(ngModel)]="s.notes"></textarea></label>
            <label class="check"><input type="checkbox" name="sa" [(ngModel)]="s.active" /> Active</label>
            <div class="row" style="margin-top: .75rem">
              <button type="button" class="btn" (click)="sup.set(null)">Cancel</button>
              <button class="btn primary" [disabled]="busy()">Save</button>
            </div>
          </form>
        }

        <div class="card">
          <h2>Suppliers</h2>
          <div class="list">
            @for (s of suppliers.data(); track s.id) {
              <div class="list-item">
                <div class="main">
                  <div class="title">{{ s.name }} @if (!s.active) {<span class="badge">inactive</span>}</div>
                  <div class="tiny">{{ s.phone }} {{ s.email }}</div>
                </div>
                @if (s.phone) {
                  <a class="btn small" [href]="'tel:' + s.phone">Call</a>
                }
                <button class="btn small" (click)="editSup(s)">Edit</button>
              </div>
            } @empty {
              <p class="empty">No suppliers yet</p>
            }
          </div>
        </div>
      </div>
    </div>
  `,
})
export class IngredientsPage {
  private readonly biz = inject(BusinessService);
  private readonly toast = inject(ToastService);
  protected readonly units = UNITS;
  protected readonly busy = signal(false);
  protected readonly ing = signal<IngDraft | null>(null);
  protected readonly sup = signal<SupDraft | null>(null);

  protected readonly ingredients = liveQuery<Ingredient>(() => query(this.biz.col('ingredients'), orderBy('name')));
  protected readonly suppliers = liveQuery<Supplier>(() => query(this.biz.col('suppliers'), orderBy('name')));
  private readonly supplierMap = computed(() => new Map(this.suppliers.data().map((s) => [s.id, s.name])));

  supplierName(id?: string) {
    return id ? (this.supplierMap().get(id) ?? '') : '';
  }

  editIng(i: Ingredient | null) {
    this.sup.set(null);
    this.ing.set({
      id: i?.id ?? null,
      name: i?.name ?? '',
      unit: i?.unit ?? 'each',
      opening: i ? i.openingQty : 0,
      cost: i ? (i.unitCostCents / 100).toFixed(2) : '',
      reorder: i?.reorderLevel ?? 0,
      supplierId: i?.supplierId ?? '',
      active: i?.active ?? true,
      countDaily: i?.countDaily ?? false,
    });
  }

  editSup(s: Supplier | null) {
    this.ing.set(null);
    this.sup.set({ id: s?.id ?? null, name: s?.name ?? '', phone: s?.phone ?? '', email: s?.email ?? '', notes: s?.notes ?? '', active: s?.active ?? true });
  }

  async saveIng() {
    const d = this.ing();
    if (!d) return;
    const unitCostCents = parseRandToCents(d.cost);
    if (!d.name.trim() || unitCostCents === null) return this.toast.error('Enter a name and a valid cost');
    const common = { name: d.name.trim(), unitCostCents, reorderLevel: Number(d.reorder) || 0, supplierId: d.supplierId, active: d.active, countDaily: d.countDaily, ...this.biz.stamp() };
    await this.run(async () => {
      if (d.id) {
        await updateDoc(this.biz.docRef('ingredients', d.id), common);
      } else {
        const ref = doc(this.biz.col('ingredients'));
        const opening = Math.max(0, Number(d.opening) || 0);
        await setDoc(ref, { id: ref.id, unit: d.unit, openingQty: opening, currentQty: opening, ...common });
      }
      this.ing.set(null);
    });
  }

  async saveSup() {
    const s = this.sup();
    if (!s || !s.name.trim()) return this.toast.error('Enter the supplier name');
    await this.run(async () => {
      const ref = s.id ? this.biz.docRef('suppliers', s.id) : doc(this.biz.col('suppliers'));
      await setDoc(ref, { id: ref.id, name: s.name.trim(), phone: s.phone.trim(), email: s.email.trim(), notes: s.notes.trim(), active: s.active, ...this.biz.stamp() }, { merge: true });
      this.sup.set(null);
    });
  }

  private async run(fn: () => Promise<void>) {
    this.busy.set(true);
    try {
      await fn();
      this.toast.ok('Saved');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
