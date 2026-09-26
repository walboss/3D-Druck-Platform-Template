import { Component, input, output } from '@angular/core';

export interface CategoryBarOption {
  name: string;
  value: string;
  season: boolean;
}

// Kategorie-Leiste über dem Katalog: horizontal wischbar, bleibt beim
// Scrollen unter dem Header sichtbar (sticky). Ein Tab = genau diese
// Kategorie; "Alle" bzw. erneutes Tippen auf den aktiven Tab hebt den Filter
// auf. Mehrfachauswahl bleibt über das Kategorien-Dropdown möglich.
@Component({
  selector: 'app-category-bar',
  standalone: true,
  templateUrl: './category-bar.html',
  styleUrl: './category-bar.scss',
})
export class CategoryBar {
  readonly categories = input.required<CategoryBarOption[]>();
  readonly selected = input.required<string[]>();
  readonly selectedChange = output<string[]>();

  isActive(value: string): boolean {
    const selected = this.selected();
    return selected.length === 1 && selected[0] === value;
  }

  select(value: string | null, event: Event): void {
    this.selectedChange.emit(value === null || this.isActive(value) ? [] : [value]);
    (event.currentTarget as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
}
