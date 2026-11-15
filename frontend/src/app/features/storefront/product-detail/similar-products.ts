import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CurrencyPipe } from '@angular/common';

import { CatalogProduct } from '../../../core/models/db-types';

// "Ähnliche Produkte" unter der Produktseite (gleiche Kategorie).
import { SizedImage } from '../../../shared/sized-image/sized-image';
@Component({
  selector: 'app-similar-products',
  standalone: true,
  imports: [SizedImage, CurrencyPipe, RouterLink],
  templateUrl: './similar-products.html',
  styleUrl: './similar-products.scss',
})
export class SimilarProducts {
  readonly products = input.required<CatalogProduct[]>();
  readonly showPrices = input(false);

  image(product: CatalogProduct): string | null {
    return product.images?.[0]?.url ?? null;
  }
}
