export interface NavItem {
  path: string;
  label: string;
  ico: string;
  group: 'Shop' | 'Owner' | 'Setup';
}

export const STAFF_NAV: NavItem[] = [
  { path: '/pos', label: 'Sell', ico: '🛒', group: 'Shop' },
  { path: '/orders', label: 'Orders', ico: '🍞', group: 'Shop' },
  { path: '/shift', label: 'Shift', ico: '⏱️', group: 'Shop' },
  { path: '/sales', label: 'Sales', ico: '🧾', group: 'Shop' },
  { path: '/stock', label: 'Stock', ico: '📦', group: 'Shop' },
  { path: '/expenses', label: 'Expenses', ico: '💸', group: 'Shop' },
];

export const OWNER_NAV: NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', ico: '📊', group: 'Owner' },
  { path: '/approvals', label: 'Approvals', ico: '✅', group: 'Owner' },
  { path: '/cash', label: 'Cash-ups', ico: '💰', group: 'Owner' },
  { path: '/reports', label: 'Reports', ico: '📈', group: 'Owner' },
  { path: '/notifications', label: 'Alerts', ico: '🔔', group: 'Owner' },
  { path: '/audit', label: 'Activity log', ico: '🕵️', group: 'Owner' },
  { path: '/cctv', label: 'CCTV', ico: '📹', group: 'Owner' },
  { path: '/products', label: 'Menu & recipes', ico: '📋', group: 'Setup' },
  { path: '/ingredients', label: 'Ingredients', ico: '🥔', group: 'Setup' },
  { path: '/employees', label: 'Staff', ico: '👥', group: 'Setup' },
  { path: '/shops', label: 'My shops', ico: '🏪', group: 'Setup' },
  { path: '/settings', label: 'Settings', ico: '⚙️', group: 'Setup' },
];
