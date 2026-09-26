import { Routes } from '@angular/router';
import { adminAuthGuard } from './core/guards/admin-auth.guard';
import { shopEnabledGuard } from './core/guards/shop-enabled.guard';
import { customRequestEnabledGuard } from './core/guards/custom-request-enabled.guard';
import { LEGAL_PAGES_ENABLED } from './core/legal-pages';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./layouts/storefront-layout/storefront-layout').then((m) => m.StorefrontLayout),
    children: [
      { path: '', redirectTo: 'katalog', pathMatch: 'full' },
      {
        path: 'katalog',
        loadComponent: () =>
          import('./features/storefront/catalog/catalog-list').then((m) => m.CatalogList),
      },
      {
        path: 'produkt/:id',
        loadComponent: () =>
          import('./features/storefront/product-detail/product-detail').then((m) => m.ProductDetail),
      },
      {
        path: 'likes',
        loadComponent: () => import('./features/storefront/likes/likes-list').then((m) => m.LikesList),
      },
      {
        path: 'wunschliste',
        canActivate: [shopEnabledGuard],
        loadComponent: () => import('./features/storefront/cart/cart-view').then((m) => m.CartView),
      },
      {
        path: 'warenkorb',
        canActivate: [shopEnabledGuard],
        loadComponent: () => import('./features/storefront/cart/cart-view').then((m) => m.CartView),
      },
      {
        path: 'anfrage-abschicken',
        canActivate: [shopEnabledGuard],
        loadComponent: () => import('./features/storefront/checkout/checkout').then((m) => m.Checkout),
      },
      {
        path: 'checkout',
        canActivate: [shopEnabledGuard],
        loadComponent: () => import('./features/storefront/checkout/checkout').then((m) => m.Checkout),
      },
      {
        path: 'uebermittelt',
        loadComponent: () =>
          import('./features/storefront/order-confirmation/order-confirmation').then(
            (m) => m.OrderConfirmation,
          ),
      },
      {
        path: 'bestellbestaetigung',
        loadComponent: () =>
          import('./features/storefront/order-confirmation/order-confirmation').then(
            (m) => m.OrderConfirmation,
          ),
      },
      {
        path: 'individualanfrage',
        canActivate: [customRequestEnabledGuard],
        loadComponent: () =>
          import('./features/storefront/custom-request/custom-request-form').then(
            (m) => m.CustomRequestForm,
          ),
      },
      {
        path: 'vorschlagen',
        loadComponent: () =>
          import('./features/storefront/suggest-model/suggest-model-form').then((m) => m.SuggestModelForm),
      },
      ...(LEGAL_PAGES_ENABLED
        ? [
            {
              path: 'impressum',
              loadComponent: () => import('./features/storefront/legal/impressum').then((m) => m.Impressum),
            },
            {
              path: 'datenschutz',
              loadComponent: () => import('./features/storefront/legal/datenschutz').then((m) => m.Datenschutz),
            },
          ]
        : []),
      {
        path: 'angebot/:token',
        loadComponent: () =>
          import('./features/storefront/offer-view/offer-view').then((m) => m.OfferView),
      },
      {
        path: 'tracking/:token',
        loadComponent: () =>
          import('./features/storefront/order-tracking/order-tracking').then((m) => m.OrderTracking),
      },
    ],
  },
  {
    path: 'admin/login',
    loadComponent: () => import('./features/admin/login/admin-login').then((m) => m.AdminLogin),
  },
  {
    path: 'admin',
    loadComponent: () => import('./layouts/admin-layout/admin-layout').then((m) => m.AdminLayout),
    canActivate: [adminAuthGuard],
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/admin/dashboard/admin-dashboard').then((m) => m.AdminDashboard),
      },
      {
        path: 'bestellungen',
        loadComponent: () =>
          import('./features/admin/orders/admin-orders-list').then((m) => m.AdminOrdersList),
      },
      {
        path: 'bestellungen/:id',
        loadComponent: () =>
          import('./features/admin/orders/admin-order-detail').then((m) => m.AdminOrderDetail),
      },
      {
        path: 'produktion',
        loadComponent: () =>
          import('./features/admin/production/admin-production-list').then((m) => m.AdminProductionList),
      },
      {
        path: 'produktion/:id',
        loadComponent: () =>
          import('./features/admin/production/admin-production-detail').then((m) => m.AdminProductionDetail),
      },
      {
        path: 'drucker',
        loadComponent: () =>
          import('./features/admin/printers/admin-printers').then((m) => m.AdminPrinters),
      },
      {
        path: 'katalog',
        loadComponent: () =>
          import('./features/admin/catalog-admin/admin-catalog-list').then((m) => m.AdminCatalogList),
      },
      {
        path: 'katalog/stammdaten',
        loadComponent: () =>
          import('./features/admin/catalog-admin/admin-color-finish-list').then((m) => m.AdminColorFinishList),
      },
      {
        path: 'katalog/saisons',
        loadComponent: () =>
          import('./features/admin/catalog-admin/admin-category-seasons').then((m) => m.AdminCategorySeasons),
      },
      {
        path: 'katalog/vorschlaege',
        loadComponent: () =>
          import('./features/admin/catalog-admin/admin-suggestions-list').then((m) => m.AdminSuggestionsList),
      },
      {
        path: 'katalog/import',
        loadComponent: () =>
          import('./features/admin/catalog-admin/admin-makerworld-import').then((m) => m.AdminMakerworldImport),
      },
      {
        path: 'katalog/neu',
        loadComponent: () =>
          import('./features/admin/catalog-admin/admin-product-editor').then((m) => m.AdminProductEditor),
      },
      {
        path: 'katalog/:id',
        loadComponent: () =>
          import('./features/admin/catalog-admin/admin-product-editor').then((m) => m.AdminProductEditor),
      },
      {
        path: 'angebote',
        loadComponent: () =>
          import('./features/admin/offers-inbox/admin-offers-hub').then((m) => m.AdminOffersHub),
      },
      {
        path: 'angebote/anfrage/:id',
        loadComponent: () =>
          import('./features/admin/offers-inbox/admin-custom-request-detail').then(
            (m) => m.AdminCustomRequestDetail,
          ),
      },
      {
        path: 'lager',
        loadComponent: () =>
          import('./features/admin/inventory/admin-inventory').then((m) => m.AdminInventory),
      },
      {
        path: 'reklamationen',
        loadComponent: () =>
          import('./features/admin/complaints/admin-complaints').then((m) => m.AdminComplaints),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/admin/settings/admin-settings').then((m) => m.AdminSettings),
      },
      {
        path: 'sicherheit',
        loadComponent: () =>
          import('./features/admin/security/admin-security').then((m) => m.AdminSecurity),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
