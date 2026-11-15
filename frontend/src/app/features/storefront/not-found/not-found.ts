import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';

// Unbekannte Adresse (Review L7): klare Meldung + Weg zurück, statt still
// zum Katalog zu springen.
@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [RouterLink, ButtonModule],
  template: `
    <div class="not-found app-card">
      <i class="pi pi-compass"></i>
      <h1>Seite nicht gefunden</h1>
      <p>Diese Adresse gibt es (nicht mehr). Vielleicht findest du im Katalog, was du suchst.</p>
      <p-button label="Zum Katalog" icon="pi pi-th-large" routerLink="/katalog"></p-button>
    </div>
  `,
  styles: `
    .not-found {
      max-width: 32rem;
      margin: 2rem auto;
      padding: 2rem 1.5rem;
      text-align: center;
    }
    .not-found i {
      font-size: 2.5rem;
      color: var(--app-text-muted);
    }
    .not-found h1 {
      margin: 0.75rem 0 0.5rem;
    }
    .not-found p {
      color: var(--app-text-muted);
      margin: 0 0 1.25rem;
    }
  `,
})
export class NotFound {}
