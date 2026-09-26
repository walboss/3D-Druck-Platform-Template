import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

// Rechtstexte mit [PLATZHALTER] — Inhalte muss der Betreiber ergänzen/prüfen.
@Component({
  selector: 'app-datenschutz',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './datenschutz.html',
  styleUrl: './legal.scss',
})
export class Datenschutz {}
