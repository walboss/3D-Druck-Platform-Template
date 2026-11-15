import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { PricingService } from './pricing.service';
import { MakerworldPlate, PlateAnalysis } from '../utils/makerworld-plates.util';

export interface MakerworldImportResult {
  estimatedPrintMinutes: number | null;
  estimatedWeightG: number | null;
  title: string | null;
  // Spec 27 §4: deutsche Übersetzung (Workers AI, best-effort, null bei Fehler),
  // Tags original/übersetzt, erste MakerWorld-Kategorie, numerische Modell-ID.
  titleDe: string | null;
  images: string[];
  tags: string[];
  tagsDe: string[];
  category: string | null;
  // Größen-Vorschlag aus der Beschreibung (z. B. "60 mm"), fehlt bei älterem Worker.
  sizeHint?: string | null;
  // Eigener Beschreibungs-Vorschlag (KI, Entscheidung 2026-11-14); fehlt bei älterem Worker
  descriptionDe?: string | null;
  // Alle Druckprofile des Modells (Profilauswahl im Import); fehlt bei älterem Worker
  profiles?: PrintProfileOption[];
  // KI-Einordnung der Platten (Vorschlag); fehlt bei älterem Worker oder 1 Platte
  plateAnalysis?: PlateAnalysis | null;
  // 00198: Druckplatten (leer, wenn MakerWorld keine liefert)
  plates: MakerworldPlate[];
  // Druckprofil, aus dem Werte/Platten stammen (Standard-Drucker bevorzugt);
  // targetPrinter = Name des Standard-Druckers. Fehlt bei älterem Worker-Stand.
  printProfile?: {
    targetPrinter?: string | null;
    isTargetPrinter: boolean;
    printer: string | null;
    title: string | null;
    // Fehlt bei älterem Worker-Stand
    profileId?: number | null;
  } | null;
  modelId: string;
  sourceUrl: string;
}

// Druckprofil eines MakerWorld-Modells (Profilauswahl im Import, 2026-11-15)
export interface PrintProfileOption {
  id: number;
  printer: string | null;
  title: string | null;
  plateCount: number;
  // mindestens eine Platte druckt mehrere Filamente gleichzeitig (AMS)
  multicolor: boolean;
  // Profil des Standard-Druckers
  isTarget: boolean;
}

// Spec 27 §4: Antwort von POST /api/vorschlag.
export type SuggestionStatus = 'angelegt' | 'bereits_vorgeschlagen' | 'bereits_im_katalog';

@Injectable({ providedIn: 'root' })
export class WorkerApiService {
  private readonly pricing = inject(PricingService);

  constructor(private readonly http: HttpClient) {}

  async placeOrder(
    turnstileToken: string,
    orderPayload: { p_cart_session_id: string; p_customer: unknown },
  ): Promise<{ order_id: string; tracking_token: string }> {
    return firstValueFrom(
      this.http.post<{ order_id: string; tracking_token: string }>(
        `${environment.workerApiUrl}${this.pricing.apiEndpointPath()}`,
        { turnstileToken, orderPayload },
      ),
    );
  }

  // OFFENE-SECURITY-FIXES.md §5: Kundensuche im Checkout läuft über den
  // Worker (Rate-Limit + Turnstile), nicht mehr direkt als anon-RPC.
  async searchCustomer(turnstileToken: string, phone: string | null, email: string | null): Promise<boolean> {
    const result = await firstValueFrom(
      this.http.post<{ found: boolean }>(`${environment.workerApiUrl}/api/kundensuche`, {
        turnstileToken,
        phone,
        email,
      }),
    );
    return result.found === true;
  }

  // Worker erwartet multipart/form-data (handleIndividualanfrage: request.formData()),
  // requestPayload als JSON-String.
  async submitCustomRequest(turnstileToken: string, requestPayload: unknown): Promise<string> {
    const formData = new FormData();
    formData.append('turnstileToken', turnstileToken);
    formData.append('requestPayload', JSON.stringify(requestPayload));
    return firstValueFrom(
      this.http.post<string>(`${environment.workerApiUrl}/api/individualanfrage`, formData),
    );
  }

  // Spec 27 §4/§6: Modellvorschlag ohne Login (Turnstile statt Auth).
  async submitModelSuggestion(turnstileToken: string, makerworldUrl: string, note: string | null): Promise<SuggestionStatus> {
    const result = await firstValueFrom(
      this.http.post<{ status: SuggestionStatus }>(`${environment.workerApiUrl}/api/vorschlag`, {
        turnstileToken,
        makerworldUrl,
        note,
      }),
    );
    return result.status;
  }

  // Task D: Druckzeit/Gewicht-Vorschlag aus einem MakerWorld-Modell-Link
  // lesen, zusätzlich Titel und Bild-URLs (Cover + Galerie) als Vorschlag
  // für die Produkt-Stammdaten. Authentifizierter Admin-Vorgang
  // (Supabase-Access-Token statt Turnstile) — accessToken kommt aus
  // AuthService.session()?.access_token.
  async importMakerworldEstimates(
    accessToken: string,
    makerworldUrl: string,
    profileId: number | null = null,
  ): Promise<MakerworldImportResult> {
    return firstValueFrom(
      this.http.post<MakerworldImportResult>(
        `${environment.workerApiUrl}/api/admin/import-makerworld`,
        profileId ? { makerworldUrl, profileId } : { makerworldUrl },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ),
    );
  }

  /** Kurze KI-Beschreibung für ein bestehendes Produkt (Katalogpflege). */
  async generateDescription(
    accessToken: string,
    input: { title: string; tags: string[]; sizeHint: string | null; parts: string[] },
  ): Promise<string> {
    const res = await firstValueFrom(
      this.http.post<{ description: string }>(`${environment.workerApiUrl}/api/admin/beschreibung`, input, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    return res.description;
  }
}
