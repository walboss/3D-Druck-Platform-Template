import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { AuthService } from '../../core/services/auth.service';
import { AdminMakerworldService } from '../../core/services/admin-makerworld.service';
import { ThemeService } from '../../core/theme/theme.service';
import { ScrollTopButton } from '../../shared/scroll-top/scroll-top-button';

interface AdminNavItem {
  label: string;
  path: string;
  icon: string;
}

interface AdminNavGroup {
  /** Überschrift der Gruppe; null = ohne Überschrift (Dashboard) */
  title: string | null;
  items: AdminNavItem[];
}

@Component({
  selector: 'app-admin-layout',
  standalone: true,
  imports: [RouterLink, RouterOutlet, ButtonModule, ScrollTopButton],
  templateUrl: './admin-layout.html',
  styleUrl: './admin-layout.scss',
})
export class AdminLayout implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly makerworld = inject(AdminMakerworldService);
  private readonly themeService = inject(ThemeService);

  readonly theme = this.themeService.theme;

  // Badge "offene Modellvorschläge" am Menüpunkt Modellvorschläge (Spec 27 §6). Wird
  // beim Start und nach jeder Navigation aktualisiert.
  readonly openSuggestions = signal(0);

  // Menü nach Arbeitsbereichen gruppiert; die Katalog-Unterseiten waren
  // vorher nur über Knöpfe in der Katalogpflege erreichbar.
  readonly navGroups: AdminNavGroup[] = [
    {
      title: null,
      items: [{ label: 'Dashboard', path: '/admin/dashboard', icon: 'pi pi-home' }],
    },
    {
      title: 'Aufträge',
      items: [
        { label: 'Bestellungen', path: '/admin/bestellungen', icon: 'pi pi-shopping-cart' },
        { label: 'Angebote & Anfragen', path: '/admin/angebote', icon: 'pi pi-inbox' },
        { label: 'Reklamationen', path: '/admin/reklamationen', icon: 'pi pi-exclamation-triangle' },
      ],
    },
    {
      title: 'Fertigung',
      items: [
        { label: 'Produktion', path: '/admin/produktion', icon: 'pi pi-cog' },
        { label: 'Drucker', path: '/admin/drucker', icon: 'pi pi-print' },
        { label: 'Lager/Filament', path: '/admin/lager', icon: 'pi pi-database' },
      ],
    },
    {
      title: 'Katalog',
      items: [
        { label: 'Produkte', path: '/admin/katalog', icon: 'pi pi-box' },
        { label: 'Modellvorschläge', path: '/admin/katalog/vorschlaege', icon: 'pi pi-lightbulb' },
        { label: 'MakerWorld-Import', path: '/admin/katalog/import', icon: 'pi pi-download' },
        { label: 'Saison-Kategorien', path: '/admin/katalog/saisons', icon: 'pi pi-calendar' },
        { label: 'Stammdaten', path: '/admin/katalog/stammdaten', icon: 'pi pi-palette' },
      ],
    },
    {
      title: 'System',
      items: [
        { label: 'Settings', path: '/admin/settings', icon: 'pi pi-sliders-h' },
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
    void this.refreshSuggestionCount();
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => void this.refreshSuggestionCount());
  }

  private async refreshSuggestionCount(): Promise<void> {
    try {
      this.openSuggestions.set(await this.makerworld.countOpenSuggestions());
    } catch {
      this.openSuggestions.set(0);
    }
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
