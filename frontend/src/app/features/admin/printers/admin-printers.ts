import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TooltipModule } from 'primeng/tooltip';

import { AdminPrintersService, PrinterRow } from '../../../core/services/admin-printers.service';

// Druckerverwaltung (Migration 00186, Entscheidung 2026-09-24):
// mehrere Drucker, genau einer ist Standard (Stern) — auf ihm landen
// bestätigte Bestellungen automatisch. Kein Löschen, nur deaktivieren;
// der Standard-Drucker selbst kann nicht deaktiviert werden.
@Component({
  selector: 'app-admin-printers',
  standalone: true,
  imports: [
    FormsModule,
    TableModule,
    ButtonModule,
    ToggleSwitchModule,
    SkeletonModule,
    MessageModule,
    DialogModule,
    InputTextModule,
    InputNumberModule,
    TooltipModule,
  ],
  templateUrl: './admin-printers.html',
  styleUrl: './admin-printers.scss',
})
export class AdminPrinters implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly printers = signal<PrinterRow[]>([]);
  readonly busyId = signal<string | null>(null);

  // Dialog "Neuer Drucker" / "Drucker bearbeiten"
  readonly dialogVisible = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly formName = signal('');
  readonly formModel = signal('');
  readonly formPower = signal<number | null>(null);
  readonly formRate = signal<number | null>(null);
  readonly saving = signal(false);
  readonly dialogError = signal<string | null>(null);

  constructor(private readonly printersService: AdminPrintersService) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.printers.set(await this.printersService.listPrinters());
    } catch {
      this.error.set('Drucker konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  async setDefault(printer: PrinterRow): Promise<void> {
    if (printer.is_default || !printer.active) return;
    this.busyId.set(printer.id);
    this.error.set(null);
    try {
      await this.printersService.setDefaultPrinter(printer.id);
      await this.load();
    } catch {
      this.error.set('Standard-Drucker konnte nicht gesetzt werden.');
    } finally {
      this.busyId.set(null);
    }
  }

  async toggleActive(printer: PrinterRow, active: boolean): Promise<void> {
    this.error.set(null);
    if (printer.is_default && !active) {
      // Schalter optisch zurück auf "an" (ngModel-Wert neu setzen).
      this.printers.update((list) => list.map((p) => (p.id === printer.id ? { ...p } : p)));
      this.error.set('Der Standard-Drucker kann nicht deaktiviert werden — erst einen anderen Drucker zum Standard machen.');
      return;
    }
    try {
      await this.printersService.setPrinterActive(printer.id, active);
      printer.active = active;
    } catch {
      this.error.set('Status konnte nicht geändert werden.');
      await this.load();
    }
  }

  openCreateDialog(): void {
    this.editingId.set(null);
    this.formName.set('');
    this.formModel.set('');
    this.formPower.set(null);
    this.formRate.set(null);
    this.dialogError.set(null);
    this.dialogVisible.set(true);
  }

  openEditDialog(printer: PrinterRow): void {
    this.editingId.set(printer.id);
    this.formName.set(printer.name);
    this.formModel.set(printer.model);
    this.formPower.set(Number(printer.power_consumption_w));
    this.formRate.set(Number(printer.machine_hour_rate));
    this.dialogError.set(null);
    this.dialogVisible.set(true);
  }

  formatNumber(value: number, digits: number): string {
    return Number(value).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  canSave(): boolean {
    const power = this.formPower();
    const rate = this.formRate();
    return (
      this.formName().trim().length > 0 &&
      this.formModel().trim().length > 0 &&
      power != null &&
      power >= 0 &&
      rate != null &&
      rate >= 0
    );
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.dialogError.set(null);
    const input = {
      name: this.formName().trim(),
      model: this.formModel().trim(),
      power_consumption_w: this.formPower()!,
      machine_hour_rate: this.formRate()!,
    };
    try {
      const id = this.editingId();
      if (id) {
        await this.printersService.updatePrinter(id, input);
      } else {
        await this.printersService.createPrinter(input);
      }
      this.dialogVisible.set(false);
      await this.load();
    } catch {
      this.dialogError.set(this.editingId() ? 'Speichern fehlgeschlagen.' : 'Anlegen fehlgeschlagen.');
    } finally {
      this.saving.set(false);
    }
  }
}
