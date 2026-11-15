import { Component, computed, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { SelectButtonModule } from 'primeng/selectbutton';

import {
  ColorArea,
  MakerworldPlate,
  PlateMappingState,
  PlateMode,
  VariantGroup,
  colorAreas,
  effectiveAreas,
  formatMinutes,
  mergeTarget,
  multicolorPlateNos,
  plateLabel,
} from '../../core/utils/makerworld-plates.util';

// Zuordnung MakerWorld-Druckplatten → Produkte/Farbteile (Migration 00198).
// Zeigt nichts an, wenn das Modell nur eine Platte mit einer Farbe hat.
@Component({
  selector: 'app-makerworld-plate-mapping',
  standalone: true,
  imports: [FormsModule, InputTextModule, SelectButtonModule],
  templateUrl: './makerworld-plate-mapping.html',
  styleUrl: './makerworld-plate-mapping.scss',
})
export class MakerworldPlateMapping {
  readonly plates = input.required<MakerworldPlate[]>();
  // Massenimport: "Je Platte ein Produkt"; Produkt-Editor: "Nur eine Platte"
  readonly allowPerPlate = input(false);
  // 00204: „Varianten (Alternativen)“ nur im Massenimport
  readonly allowVariants = input(false);
  // KI-Hinweis zur Einordnung (null = keiner)
  readonly analysisHint = input<string | null>(null);
  readonly disabled = input(false);
  // Link zur 3D-Ansicht auf MakerWorld (null = kein Link)
  readonly viewerUrl = input<string | null>(null);
  readonly state = model.required<PlateMappingState>();

  readonly areas = computed(() => colorAreas(this.plates()));
  readonly visible = computed(() => this.areas().length > 1);
  readonly removed = computed(() => this.state().removedAreas ?? []);
  readonly multicolor = computed(() => multicolorPlateNos(this.plates(), this.removed()));
  // Gramm nach dem Entfernen (für die Anzeige an der Zielfarbe)
  private readonly effective = computed(() => new Map(effectiveAreas(this.plates(), this.removed()).map((a) => [a.key, a])));

  readonly modeOptions = computed(() => {
    const options: { label: string; value: PlateMode }[] = [
      { label: 'Farbteile (ein Produkt)', value: 'parts' },
    ];
    if (this.plates().length > 1) {
      options.push(
        this.allowPerPlate()
          ? { label: 'Je Platte ein Produkt', value: 'perPlate' }
          : { label: 'Nur eine Platte', value: 'onePlate' },
      );
    }
    if (this.allowVariants() && this.plates().length > 1) {
      options.push({ label: 'Varianten (Alternativen)', value: 'variants' });
    }
    options.push({ label: 'Einfarbig (alles zusammen)', value: 'combined' });
    return options;
  });

  readonly showAreaNames = computed(() => this.state().mode !== 'combined');

  readonly formatMinutes = formatMinutes;
  readonly labelOf = plateLabel;

  areasOf(plateNo: number): ColorArea[] {
    return this.areas().filter((a) => a.plateNo === plateNo);
  }

  isRemoved(key: string): boolean {
    return this.removed().includes(key);
  }

  /** Entfernen nur, solange auf der Platte noch eine andere Farbe übrig bleibt. */
  canRemove(area: ColorArea): boolean {
    return this.areasOf(area.plateNo).filter((a) => !this.isRemoved(a.key)).length > 1;
  }

  /** Grammzuwachs der Zielfarbe durch entfernte Farben (0 = keiner). */
  addedG(area: ColorArea): number {
    const eff = this.effective().get(area.key);
    return eff ? Math.round((eff.usedG - area.usedG) * 10) / 10 : 0;
  }

  targetLabel(area: ColorArea): string {
    const target = mergeTarget(this.areasOf(area.plateNo), this.removed());
    if (!target) return '';
    const name = this.showAreaNames() ? (this.state().areaNames[target.key] ?? '').trim() : '';
    return name || `${target.type ?? 'Filament'} · ${target.usedG} g`;
  }

  removeArea(key: string): void {
    if (this.disabled()) return;
    this.state.update((s) => ({ ...s, removedAreas: [...(s.removedAreas ?? []), key] }));
  }

  restoreArea(key: string): void {
    if (this.disabled()) return;
    this.state.update((s) => ({ ...s, removedAreas: (s.removedAreas ?? []).filter((k) => k !== key) }));
  }

  isPlateActive(plateNo: number): boolean {
    const s = this.state();
    return s.mode !== 'onePlate' || s.selectedPlate === plateNo;
  }

  setMode(mode: PlateMode | null): void {
    if (!mode) return;
    this.state.update((s) => {
      // Varianten ohne Vorschlag: je Platte eine Variante als Start
      const variantGroups =
        mode === 'variants' && !(s.variantGroups?.length)
          ? this.plates().map((p) => ({ name: `Platte ${p.plateNo}`, plateNos: [p.plateNo] }))
          : s.variantGroups;
      return { ...s, mode, variantGroups };
    });
  }

  readonly groups = computed<VariantGroup[]>(() => this.state().variantGroups ?? []);

  private setGroups(groups: VariantGroup[]): void {
    this.state.update((s) => ({ ...s, variantGroups: groups }));
  }

  setGroupName(index: number, name: string): void {
    this.setGroups(this.groups().map((g, i) => (i === index ? { ...g, name } : g)));
  }

  toggleGroupPlate(index: number, plateNo: number): void {
    if (this.disabled()) return;
    this.setGroups(
      this.groups().map((g, i) =>
        i !== index
          ? g
          : {
              ...g,
              plateNos: g.plateNos.includes(plateNo)
                ? g.plateNos.filter((n) => n !== plateNo)
                : [...g.plateNos, plateNo].sort((a, b) => a - b),
            },
      ),
    );
  }

  addGroup(): void {
    this.setGroups([...this.groups(), { name: `Variante ${this.groups().length + 1}`, plateNos: [] }]);
  }

  removeGroup(index: number): void {
    this.setGroups(this.groups().filter((_, i) => i !== index));
  }

  setAreaName(key: string, name: string): void {
    this.state.update((s) => ({ ...s, areaNames: { ...s.areaNames, [key]: name } }));
  }

  setPlateName(plateNo: number, name: string): void {
    this.state.update((s) => ({ ...s, plateNames: { ...s.plateNames, [plateNo]: name } }));
  }

  selectPlate(plateNo: number): void {
    if (this.state().mode !== 'onePlate' || this.disabled()) return;
    this.state.update((s) => ({ ...s, selectedPlate: plateNo }));
  }
}
