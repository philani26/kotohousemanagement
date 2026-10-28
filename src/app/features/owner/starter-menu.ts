import { IngredientUnit, Product } from '@shared/models';

/**
 * Optional example data the owner can load once from the Menu page to get
 * started quickly. Nothing in the app depends on it – every name, price,
 * quantity and cost is meant to be edited to match the shop.
 */
export const STARTER_INGREDIENTS: { key: string; name: string; unit: IngredientUnit; unitCostCents: number; reorderLevel: number }[] = [
  { key: 'bread', name: 'Bread (quarter loaf)', unit: 'each', unitCostCents: 450, reorderLevel: 20 },
  { key: 'chips', name: 'Potatoes / chips', unit: 'kg', unitCostCents: 1800, reorderLevel: 5 },
  { key: 'polony', name: 'Polony slice', unit: 'slice', unitCostCents: 120, reorderLevel: 30 },
  { key: 'russian', name: 'Russian sausage', unit: 'each', unitCostCents: 900, reorderLevel: 10 },
  { key: 'cheese', name: 'Cheese slice', unit: 'slice', unitCostCents: 180, reorderLevel: 20 },
  { key: 'egg', name: 'Eggs', unit: 'each', unitCostCents: 250, reorderLevel: 12 },
  { key: 'atchar', name: 'Atchar', unit: 'kg', unitCostCents: 6000, reorderLevel: 1 },
  { key: 'sauce', name: 'Sauces', unit: 'litre', unitCostCents: 4000, reorderLevel: 1 },
  { key: 'oil', name: 'Cooking oil', unit: 'litre', unitCostCents: 3500, reorderLevel: 5 },
  { key: 'cooldrink', name: 'Cold drink 440ml', unit: 'each', unitCostCents: 900, reorderLevel: 24 },
];

export const STARTER_PRODUCTS: (Pick<Product, 'name' | 'category' | 'priceCents' | 'colour'> & { recipe: [string, number][] })[] = [
  { name: 'Basic Kota', category: 'kota', priceCents: 3000, colour: '#f2b33d', recipe: [['bread', 1], ['chips', 0.15], ['polony', 2], ['atchar', 0.02], ['sauce', 0.02], ['oil', 0.03]] },
  { name: 'Russian Kota', category: 'kota', priceCents: 4500, colour: '#c2410c', recipe: [['bread', 1], ['chips', 0.15], ['polony', 2], ['russian', 1], ['atchar', 0.02], ['sauce', 0.02], ['oil', 0.04]] },
  { name: 'Cheese Kota', category: 'kota', priceCents: 4000, colour: '#eab308', recipe: [['bread', 1], ['chips', 0.15], ['polony', 2], ['cheese', 2], ['atchar', 0.02], ['sauce', 0.02], ['oil', 0.03]] },
  { name: 'Egg Kota', category: 'kota', priceCents: 4000, colour: '#fde68a', recipe: [['bread', 1], ['chips', 0.15], ['polony', 2], ['egg', 1], ['atchar', 0.02], ['sauce', 0.02], ['oil', 0.04]] },
  { name: 'Special Kota', category: 'kota', priceCents: 6000, colour: '#7c2d12', recipe: [['bread', 1], ['chips', 0.2], ['polony', 2], ['russian', 1], ['cheese', 2], ['egg', 1], ['atchar', 0.03], ['sauce', 0.03], ['oil', 0.05]] },
  { name: 'Chips (small)', category: 'sides', priceCents: 2000, colour: '#facc15', recipe: [['chips', 0.2], ['oil', 0.03]] },
  { name: 'Chips (large)', category: 'sides', priceCents: 3500, colour: '#facc15', recipe: [['chips', 0.4], ['oil', 0.05]] },
  { name: 'Cold drink', category: 'drinks', priceCents: 1500, colour: '#1d4ed8', recipe: [['cooldrink', 1]] },
  { name: 'Extra cheese', category: 'extras', priceCents: 600, colour: '#a3a3a3', recipe: [['cheese', 1]] },
  { name: 'Extra egg', category: 'extras', priceCents: 700, colour: '#a3a3a3', recipe: [['egg', 1], ['oil', 0.01]] },
];
