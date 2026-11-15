import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { AdminMakerworldService } from '../../core/services/admin-makerworld.service';
import { AdminDashboardService } from '../../core/services/admin-dashboard.service';
import { ThemeService } from '../../core/theme/theme.service';
import { ScrollTopButton } from '../../shared/scroll-top/scroll-top-button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

/** Zähler am Menüpunkt: was ist dort zu tun? */
type AdminNavBadge = 'newOrders' | 'newRequests' | 'lowStock' | 'suggestions';

interface AdminNavItem {
  label: string;
  path: string;
  icon: string;
  badge?: AdminNavBadge;
}

interface AdminNavGroup {
  /** Überschrift der Gruppe; null = ohne Überschrift (Dashboard) */
  title: string | null;
  items: AdminNavItem[];
}

@Component({
  selector: 'app-admin-layout',
  standalone: true,
  imports: [RouterLink, RouterOutlet, ScrollTopButton, ToastModule],
  // Erfolgsmeldungen der Admin-Seiten (Review C22)
  providers: [MessageService],
  templateUrl: './admin-layout.html',
  styleUrl: './admin-layout.scss',
})
export class AdminLayout implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly makerworld = inject(AdminMakerworldService);
  private readonly dashboard = inject(AdminDashboardService);
  private readonly themeService = inject(ThemeService);

  readonly theme = this.themeService.theme;

  // Zähler je Menüpunkt (Review-Vorschlag Menü 2026-11-14): neue Bestellungen,
  // neue Anfragen, kritische Spulen, offene Modellvorschläge (Spec 27 §6).
  // Wird beim Start und nach jeder Navigation aktualisiert.
  readonly badges = signal<Record<AdminNavBadge, number>>({ newOrders: 0, newRequests: 0, lowStock: 0, suggestions: 0 });

  readonly badgeTitles: Record<AdminNavBadge, string> = {
    newOrders: 'Neue Bestellungen – zu bestätigen',
    newRequests: 'Neue Anfragen',
    lowStock: 'Spulen mit kritischem Bestand',
    suggestions: 'Offene Modellvorschläge',
  };

  // Menü nach Arbeitsbereichen; Seltenes (Farben & Finishes, Saisons) unter
  // System, damit der Katalog-Bereich kurz bleibt.
  readonly navGroups: AdminNavGroup[] = [
    {
      title: null,
      items: [{ label: 'Dashboard', path: '/admin/dashboard', icon: 'pi pi-home' }],
    },
    {
      title: 'Aufträge',
      items: [
        { label: 'Bestellungen', path: '/admin/bestellungen', icon: 'pi pi-shopping-cart', badge: 'newOrders' },
        { label: 'Angebote & Anfragen', path: '/admin/angebote', icon: 'pi pi-inbox', badge: 'newRequests' },
        { label: 'Reklamationen', path: '/admin/reklamationen', icon: 'pi pi-exclamation-triangle' },
      ],
    },
    {
      title: 'Fertigung',
      items: [
        { label: 'Produktion', path: '/admin/produktion', icon: 'pi pi-cog' },
        { label: 'Drucker', path: '/admin/drucker', icon: 'pi pi-print' },
        { label: 'Filamentlager', path: '/admin/lager', icon: 'pi pi-database', badge: 'lowStock' },
      ],
    },
    {
      title: 'Katalog',
      items: [
        { label: 'Produkte', path: '/admin/katalog', icon: 'pi pi-box' },
        { label: 'Modellvorschläge', path: '/admin/katalog/vorschlaege', icon: 'pi pi-lightbulb', badge: 'suggestions' },
        { label: 'MakerWorld-Import', path: '/admin/katalog/import', icon: 'pi pi-download' },
      ],
    },
    {
      title: 'System',
      items: [
        { label: 'Einstellungen', path: '/admin/settings', icon: 'pi pi-sliders-h' },
        { label: 'Farben & Finishes', path: '/admin/katalog/stammdaten', icon: 'pi pi-palette' },
        { label: 'Saison-Kategorien', path: '/admin/katalog/saisons', icon: 'pi pi-calendar' },
        { label: 'Sicherheit', path: '/admin/sicherheit', icon: 'pi pi-shield' },
      ],
    },
  ];

  private readonly navItems = this.navGroups.flatMap((g) => g.items);

  /** Mobile: Sidebar als Off-Canvas-Menü */
  readonly menuOpen = signal(false);

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /**
   * Aktiver Menüpunkt = längster passender Pfad-Präfix, damit z. B.
   * /admin/katalog/import nicht zusätzlich "Produkte" markiert, der
   * Produkt-Editor (/admin/katalog/<id>) aber schon.
   */
  readonly activePath = computed(() => {
    const url = this.currentUrl().split(/[?#]/)[0];
    const matches = this.navItems.filter((n) => url === n.path || url.startsWith(n.path + '/'));
    return matches.sort((a, b) => b.path.length - a.path.length)[0]?.path ?? null;
  });

  /** Titel für die mobile Top-Bar: Label des aktiven Nav-Eintrags */
  readonly currentTitle = computed(() => {
    const path = this.activePath();
    return this.navItems.find((n) => n.path === path)?.label ?? 'Admin';
  });

  ngOnInit(): void {
    void this.refreshBadges();
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => void this.refreshBadges());
  }

  /** Einzelne Fehler setzen nur den betroffenen Zähler auf 0. */
  private async refreshBadges(): Promise<void> {
    const safe = (p: Promise<number>) => p.catch(() => 0);
    const [newOrders, newRequests, lowStock, suggestions] = await Promise.all([
      safe(this.dashboard.getNewOrdersCount()),
      safe(this.dashboard.getNewRequestsCount()),
      safe(this.dashboard.getLowStock().then((s) => s.length)),
      safe(this.makerworld.countOpenSuggestions()),
    ]);
    this.badges.set({ newOrders, newRequests, lowStock, suggestions });
  }

  toggleMenu(): void {
    this.menuOpen.update((v) => !v);
  }

  toggleTheme(): void {
    this.themeService.toggle();
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  async logout() {
    await this.auth.signOut();
    window.location.href = '/admin/login';
  }
}
