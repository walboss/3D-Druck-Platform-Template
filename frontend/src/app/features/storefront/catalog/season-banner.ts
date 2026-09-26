import { Component, input, output } from '@angular/core';

export interface SeasonBannerData {
  key: string;
  title: string;
  text: string;
  images: string[];
}

// Saison-Banner oben im Katalog (Migration 00188). Klick filtert auf die
// Saison-Kategorie.
@Component({
  selector: 'app-season-banner',
  standalone: true,
  templateUrl: './season-banner.html',
  styleUrl: './season-banner.scss',
})
export class SeasonBanner {
  readonly banner = input.required<SeasonBannerData>();
  readonly selected = output<string>();
}
