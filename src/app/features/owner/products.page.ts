import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { doc, orderBy, query } from '../../core/db';
import { ApiRequest } from '@shared/api';
import { inOrderQueue, productUnitCost } from '@shared/domain';
import { Ingredient, Product, ProductCategory, Recipe, RecipeLine } from '@shared/models';
import { parseRandToCents } from '@shared/money';
import { BusinessService } from '../../core/business.service';
import { ApiService } from '../../core/api.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { ZarPipe } from '../../shared/pipes';
import { STARTER_INGREDIENTS, STARTER_PRODUCTS } from './starter-menu';

interface Draft {
  id: string | null;
  name: string;
  category: Product['category'];
  price: string;
  active: boolean;
  sortOrder: number;
  colour: string;
  orderQueue: boolean;
  lines: { ingredientId: string; quantity: number | null }[];
}

@Component({
  selector: 'app-products',
  imports: [FormsModule, ZarPipe],
  template: `
    <div class="page-head">
      <h1>Menu & recipes</h1>
      <button class="btn primary" (click)="edit(null)">+ New product</button>
    </div>

    @if (!products.loading() && products.data().length === 0) {
      <div class="card">
        <h2>Start with an example kota menu?</h2>
        <p class="muted">Adds Basic, Russian, Cheese, Egg and Special kotas, chips, cold drinks and extras, with ingredients and recipes.
          Opening stock starts at zero – record your first delivery on the Stock page. Edit every price and cost to match your shop.</p>
        <button class="btn" [disabled]="busy()" (click)="loadStarter()">Load example menu</button>
      </div>
    }

    @if (exampleItems(); as ex) {
      @if (ex.products.length) {
        <div class="alert info row between" style="margin-bottom: 1rem">
          <span>Your menu still has {{ ex.products.length }} example item(s) from <em>Load example menu</em>
            ({{ ex.products.slice(0, 3).join(', ') }}{{ ex.products.length > 3 ? '…' : '' }}).</span>
          <button class="btn danger small" [disabled]="busy()" (click)="removeExample()">Remove example menu</button>
        </div>
      }
    }

    <div class="card">
      <div class="card-head">
        <h2>Categories</h2>
        <span class="tiny">The tabs on the Sell screen, in this order</span>
      </div>
      <div class="row" style="gap: .4rem">
        @for (c of categories(); track c.id; let i = $index; let first = $first; let last = $last) {
          <span class="cat-chip">
            @if (renaming() === c.id) {
              <input [(ngModel)]="renameText" [name]="'rn' + c.id" maxlength="30" style="min-height: 32px; width: 140px; padding: .2rem .5rem"
                (keydown.enter)="saveRename(c.id)" (keydown.escape)="renaming.set(null)" />
              <button class="icon-btn" (click)="saveRename(c.id)" title="Save">✓</button>
            } @else {
              <strong>{{ c.name }}</strong>
              <span class="tiny">{{ useCount(c.id) }}</span>
              <button class="icon-btn" [disabled]="first" (click)="moveCategory(i, -1)" title="Move left" aria-label="Move left">‹</button>
              <button class="icon-btn" [disabled]="last" (click)="moveCategory(i, 1)" title="Move right" aria-label="Move right">›</button>
              <button class="icon-btn" (click)="startRename(c.id, c.name)" title="Rename" aria-label="Rename">✎</button>
              <button class="icon-btn" (click)="removeCategory(c.id, c.name)" title="Remove" aria-label="Remove">✕</button>
            }
          </span>
        }
      </div>
      <form class="row" style="margin-top: .75rem" (ngSubmit)="addCategory()">
        <input name="newCat" [(ngModel)]="newCategory" maxlength="30" placeholder="New category, e.g. Burgers, Breakfast, Combos" style="max-width: 340px" />
        <button class="btn" [disabled]="!newCategory.trim() || busy()">+ Add category</button>
      </form>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Product</th><th class="r">Price</th><th class="r">Cost</th><th class="r">Margin</th><th></th></tr></thead>
            <tbody>
              @for (p of products.data(); track p.id) {
                @let cost = unitCost(p.id);
                <tr [class.dim]="!p.active">
                  <td><span style="display: inline-block; width: 10px; height: 10px; border-radius: 3px" [style.background]="p.colour || '#f2b33d'"></span> {{ p.name }}
                    <div class="tiny">{{ categoryName(p.category) }}{{ p.active ? '' : ' · hidden' }}{{ queued(p) ? '' : ' · not on order queue' }}</div></td>
                  <td class="r">{{ p.priceCents | zar }}</td>
                  <td class="r">{{ cost | zar }}</td>
                  <td class="r">
                    @if (!recipes().has(p.id)) {
                      <span class="badge warn">No recipe</span>
                    } @else {
                      {{ margin(p.priceCents, cost) }}%
                    }
                  </td>
                  <td class="nowrap">
                    <button class="btn small" (click)="edit(p)">Edit</button>
                    <button class="btn small ghost" [disabled]="busy()" (click)="remove(p)" title="Delete" [attr.aria-label]="'Delete ' + p.name">🗑</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>

      @if (draft(); as d) {
        <form class="card" (ngSubmit)="save()">
          <h2>{{ d.id ? 'Edit ' + d.name : 'New product' }}</h2>
          <div class="form-grid">
            <label class="field full"><span>Name</span><input name="name" [(ngModel)]="d.name" required maxlength="60" /></label>
            <label class="field"><span>Price (R)</span><input name="price" inputmode="decimal" [(ngModel)]="d.price" required /></label>
            <label class="field">
              <span>Category</span>
              <select name="cat" [(ngModel)]="d.category" (ngModelChange)="d.orderQueue = $event !== 'extras'">
                @for (c of categories(); track c.id) {
                  <option [value]="c.id">{{ c.name }}</option>
                }
              </select>
            </label>
            <label class="field"><span>Order on screen</span><input name="sort" type="number" [(ngModel)]="d.sortOrder" /></label>
            <label class="field"><span>Button colour</span><input name="colour" type="color" [(ngModel)]="d.colour" /></label>
          </div>
          <label class="check"><input type="checkbox" name="active" [(ngModel)]="d.active" /> Available for sale</label>
          <label class="check"><input type="checkbox" name="queue" [(ngModel)]="d.orderQueue" /> Show on the order queue <span class="tiny">(off for extras and grab-and-go items)</span></label>

          <div class="divider"></div>
          <h3>Recipe – ingredients used per one sold</h3>
          @for (line of d.lines; track $index; let i = $index) {
            <div class="row" style="margin-bottom: .4rem">
              <select [name]="'ri' + i" [(ngModel)]="line.ingredientId" style="flex: 2; min-width: 140px">
                <option value="">Choose…</option>
                @for (ing of ingredients.data(); track ing.id) {
                  <option [value]="ing.id">{{ ing.name }} ({{ ing.unit }})</option>
                }
              </select>
              <input [name]="'rq' + i" type="number" step="any" min="0" [(ngModel)]="line.quantity" style="flex: 1; min-width: 80px" placeholder="Qty" />
              <button type="button" class="btn small ghost" (click)="d.lines.splice(i, 1)">✕</button>
            </div>
          }
          <button type="button" class="btn small" (click)="d.lines.push({ ingredientId: '', quantity: null })">+ Ingredient</button>
          <p class="small" style="margin-top: .75rem">Ingredient cost per item: <strong>{{ draftCost() | zar }}</strong>
            · margin {{ margin(parse(d.price), draftCost()) }}%</p>

          <div class="row" style="margin-top: 1rem">
            <button type="button" class="btn" (click)="draft.set(null)">Cancel</button>
            <button class="btn primary" [disabled]="busy()">Save</button>
          </div>
          <p class="tiny" style="margin-top: .5rem">Price changes apply to new sales only. Past sales keep the price they were sold at. Every change is logged.</p>
        </form>
      }
    </div>
  `,
})
export class ProductsPage {
  private readonly biz = inject(BusinessService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly busy = signal(false);
  protected readonly draft = signal<Draft | null>(null);

  protected readonly products = liveQuery<Product>(() => query(this.biz.col('products'), orderBy('sortOrder')));
  protected readonly ingredients = liveQuery<Ingredient>(() => query(this.biz.col('ingredients'), orderBy('name')));
  private readonly recipeList = liveQuery<Recipe>(() => this.biz.col('recipes'));
  protected readonly recipes = computed(() => new Map(this.recipeList.data().map((r) => [r.productId, r])));
  private readonly ingredientMap = computed(() => new Map(this.ingredients.data().map((i) => [i.id, i])));

  protected unitCost(productId: string) {
    return productUnitCost(this.recipes().get(productId), this.ingredientMap());
  }

  /** Plain method: the draft is edited in place by ngModel. */
  protected draftCost() {
    const d = this.draft();
    if (!d) return 0;
    return productUnitCost({ productId: 'draft', lines: this.cleanLines(d) }, this.ingredientMap());
  }

  protected margin(price: number | null, cost: number) {
    return price ? Math.round(((price - cost) / price) * 100) : 0;
  }

  protected queued(p: Product) {
    return inOrderQueue(p);
  }

  // ---- categories (stored in business settings, in Sell-screen order) ----
  protected readonly categories = computed(() => this.biz.settings().productCategories);
  protected readonly renaming = signal<string | null>(null);
  protected renameText = '';
  protected newCategory = '';

  protected categoryName(id: string) {
    return this.categories().find((c) => c.id === id)?.name ?? id;
  }

  protected useCount(id: string) {
    const n = this.products.data().filter((p) => p.category === id).length;
    return n === 1 ? '1 product' : `${n} products`;
  }

  async addCategory() {
    const name = this.newCategory.trim();
    if (!name) return;
    if (this.categories().some((c) => c.name.toLowerCase() === name.toLowerCase())) return this.toast.error(`"${name}" already exists`);
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category';
    let id = base;
    for (let i = 2; this.categories().some((c) => c.id === id); i++) id = `${base}-${i}`;
    await this.saveCategories([...this.categories(), { id, name }], `Added ${name}`);
    this.newCategory = '';
  }

  startRename(id: string, name: string) {
    this.renaming.set(id);
    this.renameText = name;
  }

  async saveRename(id: string) {
    const name = this.renameText.trim();
    this.renaming.set(null);
    if (!name) return;
    await this.saveCategories(this.categories().map((c) => (c.id === id ? { ...c, name } : c)), 'Renamed');
  }

  async moveCategory(index: number, delta: number) {
    const list = [...this.categories()];
    const [item] = list.splice(index, 1);
    list.splice(index + delta, 0, item);
    await this.saveCategories(list);
  }

  async removeCategory(id: string, name: string) {
    const used = this.products.data().filter((p) => p.category === id).length;
    if (used) return this.toast.error(`Move the ${used} product(s) in "${name}" to another category first`);
    if (this.categories().length <= 1) return this.toast.error('Keep at least one category');
    await this.saveCategories(this.categories().filter((c) => c.id !== id), `Removed ${name}`);
  }

  private async saveCategories(productCategories: ProductCategory[], message?: string) {
    this.busy.set(true);
    try {
      await this.biz.saveSettings({ productCategories });
      if (message) this.toast.ok(message);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected parse(text: string) {
    return parseRandToCents(text);
  }

  edit(p: Product | null) {
    const recipe = p ? this.recipes().get(p.id) : undefined;
    this.draft.set({
      id: p?.id ?? null,
      name: p?.name ?? '',
      category: p?.category ?? this.categories()[0]?.id ?? 'kota',
      price: p ? (p.priceCents / 100).toFixed(2) : '',
      active: p?.active ?? true,
      sortOrder: p?.sortOrder ?? this.products.data().length + 1,
      colour: p?.colour ?? '#f2b33d',
      orderQueue: p ? inOrderQueue(p) : true,
      lines: recipe ? recipe.lines.map((l) => ({ ...l })) : [],
    });
  }

  async save() {
    const d = this.draft();
    if (!d) return;
    const priceCents = parseRandToCents(d.price);
    if (!d.name.trim() || priceCents === null) return this.toast.error('Enter a name and a valid price');
    this.busy.set(true);
    try {
      const ref = d.id ? this.biz.docRef('products', d.id) : doc(this.biz.col('products'));
      // product and recipe are saved together (all or nothing), checked and logged on the server
      await this.api.call('saveCatalog', {
        writes: [
          {
            collection: 'products',
            id: ref.id,
            data: { name: d.name.trim(), category: d.category, priceCents, active: d.active, sortOrder: Number(d.sortOrder) || 0, colour: d.colour, orderQueue: d.orderQueue },
          },
          { collection: 'recipes', id: ref.id, data: { lines: this.cleanLines(d) } },
        ],
      });
      this.toast.ok('Saved');
      this.draft.set(null);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  /** Items that still look exactly like the example menu (same name and price, unchanged since loading). */
  protected readonly exampleItems = computed(() => {
    const starter = new Map(STARTER_PRODUCTS.map((p) => [p.name, p.priceCents]));
    const starterIngredients = new Map(STARTER_INGREDIENTS.map((i) => [i.name, i.unitCostCents]));
    const products = this.products.data().filter((p) => starter.get(p.name) === p.priceCents);
    const ingredients = this.ingredients.data().filter((i) => starterIngredients.get(i.name) === i.unitCostCents);
    return { products: products.map((p) => p.name), productIds: products.map((p) => p.id), ingredientIds: ingredients.map((i) => i.id) };
  });

  async removeExample() {
    const ex = this.exampleItems();
    const keep = new Set(ex.productIds);
    // keep stock items still used by products you added yourself
    const usedElsewhere = new Set(
      this.recipeList.data().filter((r) => !keep.has(r.productId)).flatMap((r) => r.lines.map((l) => l.ingredientId)),
    );
    const ingredients = ex.ingredientIds.filter((id) => !usedElsewhere.has(id));
    if (!confirm(`Delete ${ex.productIds.length} example menu item(s) and ${ingredients.length} example stock item(s)? Past sales are not affected.`)) return;
    await this.runDelete({ products: ex.productIds, ingredients }, 'Example menu removed');
  }

  async remove(p: Product) {
    if (!confirm(`Delete "${p.name}" and its recipe? Past sales keep their records. To stop selling it for now, untick "Available for sale" instead.`)) return;
    await this.runDelete({ products: [p.id] }, `Deleted ${p.name}`);
    if (this.draft()?.id === p.id) this.draft.set(null);
  }

  private async runDelete(req: { products?: string[]; ingredients?: string[] }, message: string) {
    this.busy.set(true);
    try {
      await this.api.call('deleteCatalog', req);
      this.toast.ok(message);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async loadStarter() {
    this.busy.set(true);
    try {
      const ids = new Map<string, string>();
      const writes: ApiRequest<'saveCatalog'>['writes'] = [];
      for (const ing of STARTER_INGREDIENTS) {
        const ref = doc(this.biz.col('ingredients'));
        ids.set(ing.key, ref.id);
        writes.push({ collection: 'ingredients', id: ref.id, data: { name: ing.name, unit: ing.unit, unitCostCents: ing.unitCostCents, reorderLevel: ing.reorderLevel, openingQty: 0, active: true } });
      }
      STARTER_PRODUCTS.forEach((p, i) => {
        const ref = doc(this.biz.col('products'));
        writes.push({ collection: 'products', id: ref.id, data: { name: p.name, category: p.category, priceCents: p.priceCents, colour: p.colour, active: true, sortOrder: i + 1 } });
        writes.push({ collection: 'recipes', id: ref.id, data: { lines: p.recipe.map(([key, quantity]) => ({ ingredientId: ids.get(key)!, quantity })) } });
      });
      await this.api.call('saveCatalog', { writes });
      this.toast.ok('Example menu loaded – now check the prices');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  private cleanLines(d: Draft): RecipeLine[] {
    return d.lines.filter((l) => l.ingredientId && (l.quantity ?? 0) > 0).map((l) => ({ ingredientId: l.ingredientId, quantity: Number(l.quantity) }));
  }
}
