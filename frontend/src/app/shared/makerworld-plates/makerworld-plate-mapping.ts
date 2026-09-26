import { Component, computed, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { SelectButtonModule } from 'primeng/selectbutton';

import {
  ColorArea,
  MakerworldPlate,
  PlateMappingState,
  PlateMode,
  colorAreas,
  formatMinutes,
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
  readonly disabled = input(false);
  readonly state = model.required<PlateMappingState>();

  readonly areas = computed(() => colorAreas(this.plates()));
  readonly visible = computed(() => this.areas().length > 1);

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
    options.push({ label: 'Einfarbig (alles zusammen)', value: 'combined' });
    return options;
  });

  readonly showAreaNames = computed(() => this.state().mode !== 'combined');

  readonly formatMinutes = formatMinutes;

  areasOf(plateNo: number): ColorArea[] {
    return this.areas().filter((a) => a.plateNo === plateNo);
  }

  isPlateActive(plateNo: number): boolean {
    const s = this.state();
    return s.mode !== 'onePlate' || s.selectedPlate === plateNo;
  }

  setMode(mode: PlateMode | null): void {
    if (!mode) return;
    this.state.update((s) => ({ ...s, mode }));
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
