import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { TabsModule } from 'primeng/tabs';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { AutoCompleteModule, AutoCompleteCompleteEvent } from 'primeng/autocomplete';
import { DatePickerModule } from 'primeng/datepicker';
import { TextareaModule } from 'primeng/textarea';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';

import { FilamentService, SpoolAvailability, FilamentProductOption, FilamentProductDetail } from '../../../core/services/filament.service';
import { AdminInventoryService, BWareEligibleItem, MovementRow } from '../../../core/services/admin-inventory.service';
import { AdminCatalogService } from '../../../core/services/admin-catalog.service';

const BASE_MANUFACTURERS = ['Jayo', 'Bambulab'];

// Komfort-Vorschläge für Produktname je Hersteller — kein Preset-Katalog mit
// Kalkulationswerten, nur Textbausteine (Admin-Wunsch).
const BASE_PRODUCT_NAMES_BY_MANUFACTURER: Record<string, string[]> = {
  jayo: ['PLA+', 'PLA+ Matt'],
  bambulab: ['PLA Basic', 'PLA Matte'],
};

function toDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

@Component({
  selector: 'app-admin-inventory',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    TabsModule,
    TableModule,
    TagModule,
    ButtonModule,
    DialogModule,
    SelectModule,
    InputNumberModule,
    InputTextModule,
    AutoCompleteModule,
    DatePickerModule,
    TextareaModule,
    SkeletonModule,
    MessageModule,
  ],
  templateUrl: './admin-inventory.html',
  styleUrl: './admin-inventory.scss',
})
export class AdminInventory implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly spools = signal<SpoolAvailability[]>([]);
  readonly movements = signal<MovementRow[]>([]);
  readonly bWareItems = signal<BWareEligibleItem[]>([]);

  readonly inboundDialogVisible = signal(false);
  readonly inboundSpoolId = signal<string | null>(null);
  readonly inboundAmount = signal(0);
  readonly inboundNote = signal('');
  readonly actionRunning = signal(false);
  readonly actionError = signal<string | null>(null);

  readonly bWareDialogVisible = signal(false);
  readonly bWareTarget = signal<BWareEligibleItem | null>(null);
  readonly bWareQty = signal(0);
  readonly bWareNote = signal('');

  readonly colors = signal<{ id: string; name: string; hex: string | null }[]>([]);
  readonly finishes = signal<{ id: string; name: string }[]>([]);

  readonly filamentDialogVisible = signal(false);
  readonly filamentManufacturer = signal('');
  readonly filamentProductName = signal('');
  readonly filamentMaterial = signal('');
  readonly filamentColorId = signal<string | null>(null);
  readonly filamentFinishId = signal<string | null>(null);
  readonly filamentDiameterMm = signal(1.75);
  readonly filamentCreating = signal(false);
  readonly filamentError = signal<string | null>(null);
  readonly editingFilamentId = signal<string | null>(null);
  readonly filamentProductsList = signal<FilamentProductDetail[]>([]);
  private reopenSpoolDialogAfterFilamentCreate = false;

  private knownManufacturers: string[] = [...BASE_MANUFACTURERS];
  private productNamesByManufacturer = new Map<string, string[]>();
  readonly manufacturerSuggestions = signal<string[]>([]);
  readonly productNameSuggestions = signal<string[]>([]);

  readonly filamentProducts = signal<FilamentProductOption[]>([]);
  readonly spoolDialogVisible = signal(false);
  readonly spoolFilamentProductId = signal<string | null>(null);
  readonly spoolPurchasePrice = signal<number | null>(null);
  readonly spoolGrossWeightG = signal<number | null>(null);
  readonly spoolTareWeightG = signal<number | null>(null);
  readonly spoolPurchaseDate = signal<Date | null>(null);
  readonly spoolCreating = signal(false);
  readonly spoolError = signal<string | null>(null);
  readonly editingSpoolId = signal<string | null>(null);

  constructor(
    private readonly filamentService: FilamentService,
    private readonly inventoryService: AdminInventoryService,
    private readonly catalogService: AdminCatalogService,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [spools, movements, bWareItems, filamentProductsList] = await Promise.all([
        this.filamentService.getSpoolsWithAvailability(),
        this.inventoryService.getMovementHistory(),
        this.inventoryService.getBWareEligibleItems(),
        this.filamentService.listAllFilamentProducts(),
      ]);
      this.spools.set(spools);
      this.movements.set(movements);
      this.bWareItems.set(bWareItems);
      this.filamentProductsList.set(filamentProductsList);
    } catch {
      this.error.set('Daten konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  openInboundDialog(): void {
    this.inboundSpoolId.set(null);
    this.inboundAmount.set(0);
    this.inboundNote.set('');
    this.actionError.set(null);
    this.inboundDialogVisible.set(true);
  }

  async confirmInbound(): Promise<void> {
    const spoolId = this.inboundSpoolId();
    const amount = this.inboundAmount();
    if (!spoolId || amount <= 0) return;
    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.inventoryService.recordInboundMovement(spoolId, amount, this.inboundNote().trim() || null);
      this.inboundDialogVisible.set(false);
      await this.load();
    } catch {
      this.actionError.set('Wareneingang konnte nicht erfasst werden.');
    } finally {
      this.actionRunning.set(false);
    }
  }

  openBWareDialog(item: BWareEligibleItem): void {
    this.bWareTarget.set(item);
    this.bWareQty.set(item.bookableQty);
    this.bWareNote.set('');
    this.actionError.set(null);
    this.bWareDialogVisible.set(true);
  }

  async confirmBWare(): Promise<void> {
    const item = this.bWareTarget();
    const qty = this.bWareQty();
    const note = this.bWareNote().trim();
    if (!item || qty <= 0 || !note) return;
    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.inventoryService.bookBWare(item.batchItemId, qty, note);
      this.bWareDialogVisible.set(false);
      await this.load();
    } catch {
      this.actionError.set('B-Ware-Buchung fehlgeschlagen.');
    } finally {
      this.actionRunning.set(false);
    }
  }

  private async ensureColorsFinishesLoaded(): Promise<void> {
    if (this.colors().length > 0 || this.finishes().length > 0) return;
    const [colors, finishes] = await Promise.all([this.catalogService.getAllColors(), this.catalogService.getAllFinishes()]);
    this.colors.set(colors);
    this.finishes.set(finishes);
  }

  private async loadFilamentProducts(): Promise<void> {
    this.filamentProducts.set(await this.filamentService.listActiveFilamentProducts());
  }

  private async loadManufacturerAndProductNameSuggestions(): Promise<void> {
    try {
      const pairs = await this.filamentService.listManufacturerProductNamePairs();
      const manufacturerMerged = new Map<string, string>();
      for (const m of BASE_MANUFACTURERS) manufacturerMerged.set(m.toLocaleLowerCase('de'), m);
      for (const p of pairs) manufacturerMerged.set(p.manufacturer.toLocaleLowerCase('de'), p.manufacturer);
      this.knownManufacturers = Array.from(manufacturerMerged.values()).sort((a, b) => a.localeCompare(b, 'de'));

      const byManufacturer = new Map<string, Set<string>>();
      for (const [key, names] of Object.entries(BASE_PRODUCT_NAMES_BY_MANUFACTURER)) {
        byManufacturer.set(key, new Set(names));
      }
      for (const p of pairs) {
        const key = p.manufacturer.toLocaleLowerCase('de');
        if (!byManufacturer.has(key)) byManufacturer.set(key, new Set());
        byManufacturer.get(key)!.add(p.productName);
      }
      this.productNamesByManufacturer = new Map(Array.from(byManufacturer.entries()).map(([k, v]) => [k, Array.from(v).sort((a, b) => a.localeCompare(b, 'de'))]));
    } catch {
      // Vorschläge sind Komfort — Fehler hier blockieren den Dialog nicht.
    }
  }

  searchManufacturers(event: AutoCompleteCompleteEvent): void {
    const q = event.query.trim().toLocaleLowerCase('de');
    this.manufacturerSuggestions.set(q ? this.knownManufacturers.filter((m) => m.toLocaleLowerCase('de').includes(q)) : [...this.knownManufacturers]);
  }

  searchProductNames(event: AutoCompleteCompleteEvent): void {
    const known = this.productNamesByManufacturer.get(this.filamentManufacturer().trim().toLocaleLowerCase('de')) ?? [];
    const q = event.query.trim().toLocaleLowerCase('de');
    this.productNameSuggestions.set(q ? known.filter((n) => n.toLocaleLowerCase('de').includes(q)) : [...known]);
  }

  async openFilamentDialog(reopenSpoolAfterCreate = false): Promise<void> {
    this.filamentManufacturer.set('');
    this.filamentProductName.set('');
    this.filamentMaterial.set('');
    this.filamentColorId.set(null);
    this.filamentFinishId.set(null);
    this.filamentDiameterMm.set(1.75);
    this.filamentError.set(null);
    this.editingFilamentId.set(null);
    this.reopenSpoolDialogAfterFilamentCreate = reopenSpoolAfterCreate;
    await Promise.all([this.ensureColorsFinishesLoaded(), this.loadManufacturerAndProductNameSuggestions()]);
    this.filamentDialogVisible.set(true);
  }

  async openFilamentDialogFromSpool(): Promise<void> {
    this.spoolDialogVisible.set(false);
    await this.openFilamentDialog(true);
  }

  async openEditFilamentDialog(product: FilamentProductDetail): Promise<void> {
    this.filamentManufacturer.set(product.manufacturer);
    this.filamentProductName.set(product.productName);
    this.filamentMaterial.set(product.material);
    this.filamentColorId.set(product.colorId);
    this.filamentFinishId.set(product.finishId);
    this.filamentDiameterMm.set(product.diameterMm);
    this.filamentError.set(null);
    this.editingFilamentId.set(product.id);
    this.reopenSpoolDialogAfterFilamentCreate = false;
    await Promise.all([this.ensureColorsFinishesLoaded(), this.loadManufacturerAndProductNameSuggestions()]);
    this.filamentDialogVisible.set(true);
  }

  canCreateFilament(): boolean {
    return (
      this.filamentManufacturer().trim() !== '' &&
      this.filamentProductName().trim() !== '' &&
      this.filamentMaterial().trim() !== '' &&
      !!this.filamentColorId() &&
      !!this.filamentFinishId() &&
      this.filamentDiameterMm() > 0
    );
  }

  async confirmCreateFilament(): Promise<void> {
    if (!this.canCreateFilament()) return;
    this.filamentCreating.set(true);
    this.filamentError.set(null);
    const editingId = this.editingFilamentId();
    try {
      const input = {
        manufacturer: this.filamentManufacturer().trim(),
        productName: this.filamentProductName().trim(),
        material: this.filamentMaterial().trim(),
        colorId: this.filamentColorId()!,
        finishId: this.filamentFinishId()!,
        diameterMm: this.filamentDiameterMm(),
      };
      let newId = editingId;
      if (editingId) {
        await this.filamentService.updateFilamentProduct(editingId, input);
      } else {
        newId = await this.filamentService.createFilamentProduct(input);
      }
      this.filamentDialogVisible.set(false);
      await this.loadFilamentProducts();
      if (!editingId && this.reopenSpoolDialogAfterFilamentCreate) {
        this.spoolFilamentProductId.set(newId);
        this.spoolDialogVisible.set(true);
      }
      await this.load();
    } catch {
      this.filamentError.set(editingId ? 'Filament konnte nicht gespeichert werden.' : 'Filament konnte nicht angelegt werden.');
    } finally {
      this.filamentCreating.set(false);
    }
  }

  async openSpoolDialog(): Promise<void> {
    this.spoolFilamentProductId.set(null);
    this.spoolPurchasePrice.set(null);
    this.spoolGrossWeightG.set(null);
    this.spoolTareWeightG.set(null);
    this.spoolPurchaseDate.set(new Date());
    this.spoolError.set(null);
    this.editingSpoolId.set(null);
    await this.loadFilamentProducts();
    this.spoolDialogVisible.set(true);
  }

  async openEditSpoolDialog(spoolId: string): Promise<void> {
    this.spoolError.set(null);
    try {
      const [, detail] = await Promise.all([this.loadFilamentProducts(), this.filamentService.getSpool(spoolId)]);
      this.spoolFilamentProductId.set(detail.filamentProductId);
      this.spoolPurchasePrice.set(detail.purchasePrice);
      this.spoolGrossWeightG.set(detail.initialWeightG + detail.tareWeightG);
      this.spoolTareWeightG.set(detail.tareWeightG);
      this.spoolPurchaseDate.set(parseDateOnly(detail.purchaseDate));
      this.editingSpoolId.set(spoolId);
      this.spoolDialogVisible.set(true);
    } catch {
      this.error.set('Spule konnte nicht geladen werden.');
    }
  }

  // Anbruchgewicht (initial_weight_g) wird nicht direkt eingegeben, sondern aus
  // Brutto (Spule + Filament gewogen) minus Tara (leere Spule) berechnet —
  // sonst hat das Taragewicht-Feld keinerlei Effekt auf den erfassten Bestand.
  spoolNetWeightG(): number | null {
    const gross = this.spoolGrossWeightG();
    const tare = this.spoolTareWeightG();
    if (gross === null || tare === null) return null;
    const net = gross - tare;
    return net > 0 ? net : null;
  }

  canCreateSpool(): boolean {
    return (
      !!this.spoolFilamentProductId() &&
      this.spoolPurchasePrice() !== null &&
      this.spoolPurchasePrice()! >= 0 &&
      this.spoolGrossWeightG() !== null &&
      this.spoolTareWeightG() !== null &&
      this.spoolNetWeightG() !== null &&
      !!this.spoolPurchaseDate()
    );
  }

  async confirmCreateSpool(): Promise<void> {
    const netWeight = this.spoolNetWeightG();
    if (!this.canCreateSpool() || netWeight === null) return;
    this.spoolCreating.set(true);
    this.spoolError.set(null);
    const editingId = this.editingSpoolId();
    try {
      const input = {
        filamentProductId: this.spoolFilamentProductId()!,
        purchasePrice: this.spoolPurchasePrice()!,
        initialWeightG: netWeight,
        tareWeightG: this.spoolTareWeightG()!,
        purchaseDate: toDateOnly(this.spoolPurchaseDate()!),
      };
      if (editingId) {
        await this.filamentService.updateSpool(editingId, input);
      } else {
        await this.filamentService.createSpool(input);
      }
      this.spoolDialogVisible.set(false);
      await this.load();
    } catch {
      this.spoolError.set(editingId ? 'Spule konnte nicht gespeichert werden.' : 'Spule konnte nicht angelegt werden.');
    } finally {
      this.spoolCreating.set(false);
    }
  }
}
