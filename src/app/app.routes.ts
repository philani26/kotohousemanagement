import { Routes } from '@angular/router';
import { homeRedirect, kitchenGuard, ownerGuard, signedOutGuard, staffGuard } from './core/guards';
import { ShellComponent } from './layout/shell.component';

export const routes: Routes = [
  { path: 'login', canActivate: [signedOutGuard], loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage) },
  { path: 'setup', loadComponent: () => import('./features/auth/setup.page').then((m) => m.SetupPage) },
  {
    path: '',
    component: ShellComponent,
    canActivate: [staffGuard],
    canActivateChild: [kitchenGuard],
    children: [
      { path: '', pathMatch: 'full', canActivate: [homeRedirect], children: [] },
      // Staff
      { path: 'pos', title: 'Sell', loadComponent: () => import('./features/pos/pos.page').then((m) => m.PosPage) },
      { path: 'orders', title: 'Orders', loadComponent: () => import('./features/orders/orders.page').then((m) => m.OrdersPage) },
      { path: 'shift', title: 'Shift', loadComponent: () => import('./features/shift/shift.page').then((m) => m.ShiftPage) },
      { path: 'sales', title: 'Sales', loadComponent: () => import('./features/sales/sales.page').then((m) => m.SalesPage) },
      { path: 'expenses', title: 'Expenses', loadComponent: () => import('./features/expenses/expenses.page').then((m) => m.ExpensesPage) },
      { path: 'hours', title: 'Hours', loadComponent: () => import('./features/hours/hours.page').then((m) => m.HoursPage) },
      { path: 'stock', title: 'Stock', loadComponent: () => import('./features/stock/stock.page').then((m) => m.StockPage) },
      // Owner only (also enforced by security rules and functions)
      {
        path: '',
        canActivate: [ownerGuard],
        children: [
          { path: 'dashboard', title: 'Dashboard', loadComponent: () => import('./features/owner/dashboard.page').then((m) => m.DashboardPage) },
          { path: 'reports', title: 'Reports', loadComponent: () => import('./features/owner/reports.page').then((m) => m.ReportsPage) },
          { path: 'approvals', title: 'Approvals', loadComponent: () => import('./features/owner/approvals.page').then((m) => m.ApprovalsPage) },
          { path: 'cash', title: 'Cash-ups', loadComponent: () => import('./features/owner/cash.page').then((m) => m.CashPage) },
          { path: 'products', title: 'Menu', loadComponent: () => import('./features/owner/products.page').then((m) => m.ProductsPage) },
          { path: 'ingredients', title: 'Ingredients', loadComponent: () => import('./features/owner/ingredients.page').then((m) => m.IngredientsPage) },
          { path: 'employees', title: 'Staff', loadComponent: () => import('./features/owner/employees.page').then((m) => m.EmployeesPage) },
          { path: 'audit', title: 'Activity log', loadComponent: () => import('./features/owner/audit.page').then((m) => m.AuditPage) },
          { path: 'notifications', title: 'Alerts', loadComponent: () => import('./features/owner/notifications.page').then((m) => m.NotificationsPage) },
          { path: 'devices', title: 'Devices', loadComponent: () => import('./features/owner/devices.page').then((m) => m.DevicesPage) },
          { path: 'whatsapp', title: 'WhatsApp', loadComponent: () => import('./features/owner/whatsapp.page').then((m) => m.WhatsappPage) },
          { path: 'shops', title: 'My shops', loadComponent: () => import('./features/owner/shops.page').then((m) => m.ShopsPage) },
          { path: 'settings', title: 'Settings', loadComponent: () => import('./features/owner/settings.page').then((m) => m.SettingsPage) },
          { path: 'customers', title: 'Customers', loadComponent: () => import('./features/owner/customers.page').then((m) => m.CustomersPage) },
      { path: 'cctv', title: 'CCTV', loadComponent: () => import('./features/owner/cctv.page').then((m) => m.CctvPage) },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
