// MakerWorld: Modell-ID, Druckprofile, Platten, Schaetzwerte.
import { PLATE_NAME_MAX, decodeHtmlEntities } from "./ai";

// ---------------------------------------------------------------------------
// /api/admin/import-makerworld (Task D): Druckzeit/Gewicht eines MakerWorld-
// Modells als Vorschlag fuer die Katalogpflege lesen. Authentifizierter
// Admin-Vorgang (Supabase-Access-Token statt Turnstile).
//
// Ein einfacher server-seitiger GET auf die HTML-Modellseite (wie urspruenglich
// angedacht) scheitert an Cloudflares Bot-Schutz von makerworld.com: ein
// fetch() ohne JS-Ausfuehrung bekommt dort zuverlaessig nur die
// "Just a moment..."-Challenge-Seite (403), nie den echten Inhalt (getestet).
// Stattdessen wird MakerWorlds eigene, oeffentliche JSON-API verwendet, die
// dieselben Werte strukturiert liefert wie die .gcode.3mf-Slice-Daten aus
// Task B (Migration 00158): GET /api/v1/design-service/design/{numerische-id},
// unauthentifiziert erreichbar, kein Cloudflare-Block (verifiziert).
// WICHTIG: Diese API ist von MakerWorld nicht offiziell dokumentiert/
// garantiert (offenbar von deren eigenen Web-/App-Clients genutzt) und kann
// sich jederzeit ohne Vorwarnung aendern oder wegfallen. Jeder Fehlerfall
// (Netzwerk, 404, unerwartetes Format) faengt das best-effort ab (siehe unten).
// ---------------------------------------------------------------------------
export const MAKERWORLD_HOST_SUFFIX = "makerworld.com";

export const MAKERWORLD_MODEL_ID_PATTERN = /\/models\/(\d+)(?:[/?#-]|$)/;

export interface MakerWorldEstimates {
	// Alle Druckprofile (Profilauswahl im Import)
	profiles: PrintProfileOption[];
	estimatedPrintMinutes: number | null;
	estimatedWeightG: number | null;
	// Titel- und Bild-Vorschlaege fuer die Produkt-Stammdaten (null / leeres
	// Array, wenn die API nichts liefert -- kein Fehlerfall).
	title: string | null;
	images: string[];
	// Spec 27 §4: Tags, erste Kategorie (categories[0].name) und Modell-ID.
	tags: string[];
	category: string | null;
	// Groessen-Vorschlag aus der Beschreibung (parseSizeHint), sonst null.
	sizeHint: string | null;
	// 00198: Druckplatten des gewaehlten Druckprofils (extention.modelInfo.
	// plates) mit Zeit, Gewicht, Vorschaubild und Filamenten.
	plates: MakerWorldPlate[];
	// Gewaehltes Druckprofil: Profil des Standard-Druckers, falls vorhanden,
	// sonst das erste.
	printProfile: MakerWorldPrintProfile | null;
}

export interface MakerWorldPrintProfile {
	// Name des Standard-Druckers (printers.is_default), null = keiner gesetzt.
	targetPrinter: string | null;
	isTargetPrinter: boolean;
	printer: string | null;
	title: string | null;
	// ID des Druckprofils (MakerWorld-Link "#profileId-<id>" fuer die 3D-Ansicht)
	profileId: number | null;
}

export interface TargetPrinter {
	name: string;
	model: string | null;
}

export function normalizePrinterName(value: string): string {
	return value
		.toLowerCase()
		.replace(/\bbambu\s*lab\b|\bbambulab\b|\bbambu\b/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// Drucker, fuer den DIESES Profil geslict ist: nur die eigene compatibility
// (Abruf 2026-09-27: extention.modelInfo.compatibility.devProductName, z. B.
// "A1", "X2D"). otherCompatibilityModelInfo ("andere Designs, die auch dafuer
// geslict sind") wird bewusst nicht gelesen -- war Ursache eines Fehltreffers.
export function profilePrinterName(instance: Record<string, unknown>): string | null {
	const ext = instance.extention as { modelInfo?: Record<string, unknown> } | undefined;
	const compat = ext?.modelInfo?.compatibility as Record<string, unknown> | undefined;
	const candidates: unknown[] = [compat?.devProductName, compat?.printerName];
	for (const c of candidates) {
		if (typeof c === "string" && c.trim()) return c.trim();
	}
	return null;
}

// Drucker, auf denen DIESES Profil laut MakerWorld zusaetzlich laeuft, ohne
// speziell dafuer optimiert zu sein (extention.modelInfo.otherCompatibility,
// entspricht "Unterstuetzt X2D, usw." in der MakerWorld-App). Adminentscheidung
// 2026-09-27: zaehlt ebenfalls als Treffer fuer den gruenen Tag -- Werte/
// Platten kommen aber weiterhin vom tatsaechlich gewaehlten Profil.
export function otherCompatibilityPrinterNames(instance: Record<string, unknown>): string[] {
	const ext = instance.extention as { modelInfo?: Record<string, unknown> } | undefined;
	const list = ext?.modelInfo?.otherCompatibility;
	if (!Array.isArray(list)) return [];
	const names: string[] = [];
	for (const entry of list) {
		if (entry && typeof entry === "object") {
			const candidates: unknown[] = [(entry as Record<string, unknown>).devProductName, (entry as Record<string, unknown>).printerName];
			for (const c of candidates) {
				if (typeof c === "string" && c.trim()) names.push(c.trim());
			}
		}
	}
	return names;
}

// Exakter Vergleich (ohne "Bambu Lab"), damit z. B. "A1" nicht "A1 mini" trifft.
export function matchesTarget(name: string, target: TargetPrinter): boolean {
	const normalized = normalizePrinterName(name);
	if (!normalized) return false;
	return [target.model, target.name].some((n) => !!n && normalizePrinterName(n) === normalized);
}

export function isTargetPrinterProfile(instance: Record<string, unknown>, target: TargetPrinter): boolean {
	const printer = profilePrinterName(instance);
	return printer !== null && matchesTarget(printer, target);
}

export function supportsTargetViaOtherCompatibility(instance: Record<string, unknown>, target: TargetPrinter): boolean {
	return otherCompatibilityPrinterNames(instance).some((n) => matchesTarget(n, target));
}

export function pickPrintProfile(
	instances: unknown,
	target: TargetPrinter | null,
	// Vom Admin gewaehltes Profil (Profilauswahl im Import, 2026-11-15)
	preferredId: number | null = null,
): { instance: Record<string, unknown> | undefined; profile: MakerWorldPrintProfile | null } {
	if (!Array.isArray(instances)) return { instance: undefined, profile: null };
	const list = instances.filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null);
	if (list.length === 0) return { instance: undefined, profile: null };
	const preferred = preferredId !== null ? list.find((i) => i.id === preferredId) : undefined;
	const match = target ? list.find((i) => isTargetPrinterProfile(i, target)) : undefined;
	const instance = preferred ?? match ?? list[0];
	const isTargetPrinter =
		(target !== null && isTargetPrinterProfile(instance, target)) ||
		(target !== null && supportsTargetViaOtherCompatibility(instance, target));
	return {
		instance,
		profile: {
			targetPrinter: target?.name ?? null,
			isTargetPrinter,
			printer: profilePrinterName(instance),
			title: typeof instance.title === "string" && instance.title.trim() ? instance.title.trim() : null,
			profileId: typeof instance.id === "number" && instance.id > 0 ? instance.id : null,
		},
	};
}

// Alle Druckprofile eines Modells fuer die Profilauswahl im Import
// (Entscheidung Betreiber 2026-11-15): Drucker, Titel, Plattenzahl und ob
// mindestens eine Platte mehrere Filamente gleichzeitig druckt (AMS).
export interface PrintProfileOption {
	id: number;
	printer: string | null;
	title: string | null;
	plateCount: number;
	multicolor: boolean;
	isTarget: boolean;
}

export function listPrintProfiles(instances: unknown, target: TargetPrinter | null): PrintProfileOption[] {
	if (!Array.isArray(instances)) return [];
	const out: PrintProfileOption[] = [];
	for (const raw of instances) {
		if (typeof raw !== "object" || raw === null) continue;
		const inst = raw as Record<string, unknown>;
		if (typeof inst.id !== "number" || inst.id <= 0) continue;
		const plates = parseMakerWorldPlates(inst);
		out.push({
			id: inst.id,
			printer: profilePrinterName(inst),
			title: typeof inst.title === "string" && inst.title.trim() ? inst.title.trim().slice(0, 120) : null,
			plateCount: plates.length,
			multicolor: plates.some((pl) => pl.filaments.length >= 2),
			isTarget: target !== null && isTargetPrinterProfile(inst, target),
		});
	}
	return out;
}

export interface MakerWorldPlateFilament {
	slot: string;
	type: string | null;
	color: string | null;
	usedG: number;
}

export interface MakerWorldPlate {
	plateNo: number;
	printMinutes: number | null;
	weightG: number | null;
	imageUrl: string | null;
	filaments: MakerWorldPlateFilament[];
	// Plattenname des Erstellers (z. B. "Scarf & Hat"), null = keiner
	name: string | null;
	// Deutsche Uebersetzung des Namens (best-effort), null = keine
	nameDe: string | null;
}

export function toNumber(value: unknown): number | null {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
	return Number.isFinite(n) ? n : null;
}

export function plateImageUrl(plate: Record<string, unknown>): string | null {
	const thumb = plate.thumbnail;
	const candidates: unknown[] = [
		typeof thumb === "object" && thumb !== null ? (thumb as Record<string, unknown>).url : thumb,
		plate.thumbnailUrl,
		plate.pic,
		plate.picture,
	];
	for (const c of candidates) {
		if (typeof c === "string" && /^https?:\/\//i.test(c)) return c;
	}
	// Fallback: irgendein Bild-Link im Platten-Objekt (z. B. ".../plate_1.png")
	for (const v of Object.values(plate)) {
		if (typeof v === "string" && /^https?:\/\/\S+\.(png|jpe?g|webp)(\?\S*)?$/i.test(v)) return v;
	}
	return null;
}

// Liest die Platten robust aus (Feldnamen laut Abruf 2026-09-26: index,
// prediction [s], weight [g], thumbnail, filaments[{id,type,color,usedG}]).
// Unbekanntes Format -> leeres Array, nie ein Fehler.
export function parseMakerWorldPlates(instance: unknown): MakerWorldPlate[] {
	const modelInfo = (instance as { extention?: { modelInfo?: { plates?: unknown } } } | undefined)?.extention?.modelInfo;
	const rawPlates = modelInfo?.plates;
	if (!Array.isArray(rawPlates)) return [];
	const plates: MakerWorldPlate[] = [];
	rawPlates.forEach((raw, i) => {
		if (typeof raw !== "object" || raw === null) return;
		const plate = raw as Record<string, unknown>;
		const seconds = toNumber(plate.prediction);
		const weight = toNumber(plate.weight);
		const filaments: MakerWorldPlateFilament[] = [];
		if (Array.isArray(plate.filaments)) {
			for (const f of plate.filaments) {
				if (typeof f !== "object" || f === null) continue;
				const fil = f as Record<string, unknown>;
				const usedG = toNumber(fil.usedG);
				if (usedG === null || usedG <= 0) continue;
				filaments.push({
					slot: String(fil.id ?? filaments.length + 1),
					type: typeof fil.type === "string" ? fil.type : null,
					color: typeof fil.color === "string" && /^#[0-9a-f]{6}$/i.test(fil.color) ? fil.color.toUpperCase() : null,
					usedG,
				});
			}
		}
		const index = toNumber(plate.index);
		const rawName = typeof plate.name === "string" ? decodeHtmlEntities(plate.name).trim() : "";
		plates.push({
			plateNo: index !== null && index >= 1 ? Math.round(index) : i + 1,
			printMinutes: seconds !== null && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null,
			weightG: weight !== null && weight > 0 ? weight : null,
			imageUrl: plateImageUrl(plate),
			filaments,
			name: rawName ? rawName.slice(0, PLATE_NAME_MAX) : null,
			nameDe: null,
		});
	});
	return plates;
}

// Numerische Modell-ID aus einer MakerWorld-URL lesen. Nur echte
// makerworld.com-Links (Schutz vor SSRF auf beliebige Hosts) mit einem
// "/models/<id>"-Pfadsegment werden akzeptiert (Format wie
// "https://makerworld.com/en/models/921270-irgendein-titel").
export function extractMakerWorldModelId(rawUrl: string): { ok: true; id: string } | { ok: false; error: string } {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return { ok: false, error: "makerworldUrl ist keine gueltige URL" };
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return { ok: false, error: "makerworldUrl muss http(s) sein" };
	}
	// Exakt makerworld.com oder eine Subdomain -- nicht "evilmakerworld.com".
	const hostname = parsed.hostname.toLowerCase();
	if (hostname !== MAKERWORLD_HOST_SUFFIX && !hostname.endsWith(`.${MAKERWORLD_HOST_SUFFIX}`)) {
		return { ok: false, error: "Nur MakerWorld-Modell-Links werden unterstuetzt" };
	}
	const match = parsed.pathname.match(MAKERWORLD_MODEL_ID_PATTERN);
	if (!match) {
		return { ok: false, error: "Konnte keine Modell-ID aus der URL lesen (erwartet .../models/<id>-...)" };
	}
	return { ok: true, id: match[1] };
}

// Groessen-Vorschlag aus der Modellbeschreibung (summary). MakerWorld liefert
// keine strukturierten Masse, nur Freitext -- daher Best-Effort mit strengen
// Mustern, null wenn nichts Eindeutiges gefunden wird. Treffer sind nur ein
// Vorschlag fuer die Groessenangabe der Standard-Variante (Admin prueft).
// 1) Dreiermass "185 mm x 135 mm x 135 mm" (auch ohne Einheit an jedem Wert)
// 2) Ein Mass mit Stichwort davor/danach: "height 60 mm", "8 cm tall",
//    "approx. 12 cm" nach "size"/"dimension"/"diameter". Schichthoehe,
//    Wandstaerke, Duesen- und Filament-Angaben werden nicht gewertet.
export function parseSizeHint(summary: unknown): string | null {
	if (typeof summary !== "string") return null;
	const text = decodeHtmlEntities(summary.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
	const num = "\\d+(?:[.,]\\d+)?";
	const fmt = (v: string) => v.replace(",", ".");

	const triple = text.match(
		new RegExp(`(${num})\\s*(mm|cm)?\\s*[x×]\\s*(${num})\\s*(mm|cm)?\\s*[x×]\\s*(${num})\\s*(mm|cm)\\b`, "i"),
	);
	if (triple) {
		const unit = triple[6].toLowerCase();
		return `${fmt(triple[1])} × ${fmt(triple[3])} × ${fmt(triple[5])} ${unit}`;
	}

	const keyword = "(?:height|tall|high|size|dimension|dimensions|diameter|width|length|hoehe|höhe|groesse|größe|durchmesser|breite|laenge|länge)";
	const before = text.match(new RegExp(`\\b${keyword}\\b[^.\\d]{0,20}?(?:approx\\.?|about|ca\\.?|~)?\\s*(${num})\\s*(mm|cm)\\b`, "i"));
	const after = text.match(new RegExp(`(${num})\\s*(mm|cm)\\s*(?:tall|high|in height|hoch|gross|groß|large)\\b`, "i"));
	const hit = before ?? after;
	if (!hit) return null;
	const index = hit.index ?? 0;
	const context = text.slice(Math.max(0, index - 12), index + hit[0].length);
	if (/layer|wall|nozzle|infill|thickness|schicht|wand|düse|duese|filament|diameter\s*1\.75/i.test(context)) return null;
	const value = Number(fmt(hit[1]));
	if (!Number.isFinite(value) || value <= 0) return null;
	return `${fmt(hit[1])} ${hit[2].toLowerCase()}`;
}

// Ruft die MakerWorld-Design-API ab und liest Druckzeit/Gewicht des Profils
// fuer den Standard-Drucker, falls vorhanden, sonst des ersten Instance-Eintrags
// (= "primaeres Druckprofil", siehe pickPrintProfile). prediction ist in Sekunden, weight
// in Gramm (identisches Format zu Metadata/slice_info.config aus Task B).
// Fehlt ein Wert oder das Modell hat keine Instanzen: null statt Fehler
// (Best-Effort, wie beim 3mf-Import) -- das ist KEIN Fehlerfall des Requests.
//
// Zusaetzlich (Titel/Bilder-Vorschlag fuer die Produkt-Stammdaten): title
// sowie die Bild-URLs aus coverUrl (Cover) und
// designExtension.design_pictures[].url (Galerie), in dieser Reihenfolge,
// ohne Duplikate. Nur http(s)-URLs werden uebernommen. Die Bilder bleiben
// Hotlinks auf MakerWorlds CDN (source_type 'extern_link' im Frontend).
export async function fetchMakerWorldEstimates(
	modelId: string,
	targetPrinter: TargetPrinter | null = null,
	profileId: number | null = null,
): Promise<{ ok: true; estimates: MakerWorldEstimates } | { ok: false; error: string }> {
	let response: Response;
	try {
		response = await fetch(`https://${MAKERWORLD_HOST_SUFFIX}/api/v1/design-service/design/${modelId}`);
	} catch {
		return { ok: false, error: "MakerWorld ist gerade nicht erreichbar" };
	}

	if (response.status === 404) {
		return { ok: false, error: "MakerWorld-Modell nicht gefunden (Link pruefen)" };
	}
	if (!response.ok) {
		return { ok: false, error: `MakerWorld-Abfrage fehlgeschlagen (Status ${response.status})` };
	}

	let data: {
		title?: unknown;
		coverUrl?: unknown;
		tags?: unknown;
		categories?: { name?: unknown }[];
		summary?: unknown;
		designExtension?: { design_pictures?: { url?: unknown }[] };
		instances?: { prediction?: unknown; weight?: unknown; extention?: unknown }[];
	};
	try {
		data = await response.json();
	} catch {
		return { ok: false, error: "MakerWorld-Antwort konnte nicht gelesen werden" };
	}

	const { instance: chosenInstance, profile: printProfile } = pickPrintProfile(data.instances, targetPrinter, profileId);
	const profiles = listPrintProfiles(data.instances, targetPrinter);
	const predictionSeconds = typeof chosenInstance?.prediction === "number" ? chosenInstance.prediction : null;
	const weightG = typeof chosenInstance?.weight === "number" ? chosenInstance.weight : null;

	const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : null;

	const imageCandidates: unknown[] = [data.coverUrl];
	const galleryPictures = data.designExtension?.design_pictures;
	if (Array.isArray(galleryPictures)) {
		for (const picture of galleryPictures) {
			imageCandidates.push(picture?.url);
		}
	}
	const images: string[] = [];
	for (const candidate of imageCandidates) {
		if (typeof candidate !== "string" || !/^https?:\/\//i.test(candidate)) continue;
		if (!images.includes(candidate)) images.push(candidate);
	}

	const tags: string[] = [];
	if (Array.isArray(data.tags)) {
		for (const tag of data.tags) {
			if (typeof tag !== "string") continue;
			const cleaned = decodeHtmlEntities(tag).trim();
			if (cleaned && !tags.some((t) => t.toLowerCase() === cleaned.toLowerCase())) tags.push(cleaned);
		}
	}
	const firstCategory = Array.isArray(data.categories) ? data.categories[0] : undefined;
	const category =
		typeof firstCategory?.name === "string" && firstCategory.name.trim() ? firstCategory.name.trim() : null;

	return {
		ok: true,
		estimates: {
			profiles,
			estimatedPrintMinutes:
				predictionSeconds !== null && predictionSeconds > 0 ? Math.round(predictionSeconds / 60) : null,
			estimatedWeightG: weightG !== null && weightG > 0 ? weightG : null,
			title,
			images,
			tags,
			category,
			sizeHint: parseSizeHint(data.summary),
			plates: parseMakerWorldPlates(chosenInstance),
			printProfile,
		},
	};
}
