import { Component, input, output } from '@angular/core';
import { CurrencyPipe } from '@angular/common';

import { CatalogProduct } from '../../../core/models/db-types';

// "Ähnliche Produkte" unter der Produktseite (gleiche Kategorie).
@Component({
  selector: 'app-similar-products',
  standalone: true,
  imports: [CurrencyPipe],
  templateUrl: './similar-products.html',
  styleUrl: './similar-products.scss',
})
export class SimilarProducts {
  readonly products = input.required<CatalogProduct[]>();
  readonly showPrices = input(false);
  readonly selected = output<CatalogProduct>();

  image(product: CatalogProduct): string | null {
    return product.images?.[0]?.url ?? null;
  }
}
