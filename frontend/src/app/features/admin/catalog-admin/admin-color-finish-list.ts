import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ColorPickerModule } from 'primeng/colorpicker';

import { AdminCatalogService, ColorMasterRow, FinishMasterRow } from '../../../core/services/admin-catalog.service';

const HEX_PATTERN = /^#?[0-9a-fA-F]{6}$/;

// Stammdaten Farben/Finishes (specs/21): Liste, Anlegen, Aktiv-Toggle.
// Kein Löschen — Stammdaten werden nur deaktiviert (Prinzip #2).
@Component({
  selector: 'app-admin-color-finish-list',
  standalone: true,
  imports: [FormsModule, TableModule, ButtonModule, ToggleSwitchModule, SkeletonModule, MessageModule, DialogModule, InputTextModule, ColorPickerModule],
  templateUrl: './admin-color-finish-list.html',
  styleUrl: './admin-color-finish-list.scss',
})
export class AdminColorFinishList implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly colors = signal<ColorMasterRow[]>([]);
  readonly finishes = signal<FinishMasterRow[]>([]);

  // Dialog "Neue Farbe" / "Neues Finish" / "Farbe bearbeiten"
  readonly createDialogVisible = signal(false);
  readonly createKind = signal<'color' | 'finish'>('color');
  readonly newName = signal('');
  readonly newHex = signal('');
  readonly creating = signal(false);
  readonly createError = signal<string | null>(null);
  readonly editingColorId = signal<string | null>(null);

  constructor(private readonly catalogService: AdminCatalogService, private readonly router: Router) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [colors, finishes] = await Promise.all([
        this.catalogService.listColorsMaster(),
        this.catalogService.listFinishesMaster(),
      ]);
      this.colors.set(colors);
      this.finishes.set(finishes);
    } catch {
      this.error.set('Farben/Finishes konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  back(): void {
    this.router.navigate(['/admin/katalog']);
  }

  async toggleColorActive(color: ColorMasterRow, active: boolean): Promise<void> {
    try {
      await this.catalogService.setColorActive(color.id, active);
      color.active = active;
    } catch {
      this.error.set('Status konnte nicht geändert werden.');
    }
  }

  async toggleFinishActive(finish: FinishMasterRow, active: boolean): Promise<void> {
    try {
      await this.catalogService.setFinishActive(finish.id, active);
      finish.active = active;
    } catch {
      this.error.set('Status konnte nicht geändert werden.');
    }
  }

  openCreateDialog(kind: 'color' | 'finish'): void {
    this.createKind.set(kind);
    this.newName.set('');
    this.newHex.set('');
    this.editingColorId.set(null);
    this.createError.set(null);
    this.createDialogVisible.set(true);
  }

  openEditColorDialog(color: ColorMasterRow): void {
    this.createKind.set('color');
    this.newName.set(color.name);
    this.newHex.set(color.hex ?? '');
    this.editingColorId.set(color.id);
    this.createError.set(null);
    this.createDialogVisible.set(true);
  }

  // p-colorpicker liefert/erwartet Hex ohne '#' — Textfeld und Swatch-Speicherung nutzen '#RRGGBB'.
  colorPickerValue(): string {
    return this.newHex().trim().replace(/^#/, '');
  }

  onColorPickerChange(value: string): void {
    const hex = value.trim().replace(/^#/, '');
    this.newHex.set(hex ? `#${hex.toUpperCase()}` : '');
  }

  canCreate(): boolean {
    if (!this.newName().trim()) return false;
    const hex = this.newHex().trim();
    return this.createKind() === 'finish' || hex === '' || HEX_PATTERN.test(hex);
  }

  async confirmCreate(): Promise<void> {
    if (!this.canCreate()) return;
    const name = this.newName().trim();
    this.creating.set(true);
    this.createError.set(null);
    try {
      if (this.createKind() === 'color') {
        const hexRaw = this.newHex().trim();
        const hex = hexRaw ? `#${hexRaw.replace(/^#/, '').toUpperCase()}` : null;
        const editingId = this.editingColorId();
        if (editingId) {
          await this.catalogService.updateColor(editingId, name, hex);
        } else {
          await this.catalogService.createColor(name, hex);
        }
      } else {
        await this.catalogService.createFinish(name);
      }
      this.createDialogVisible.set(false);
      await this.load();
    } catch {
      this.createError.set(this.editingColorId() ? 'Speichern fehlgeschlagen.' : 'Anlegen fehlgeschlagen.');
    } finally {
      this.creating.set(false);
    }
  }
}
