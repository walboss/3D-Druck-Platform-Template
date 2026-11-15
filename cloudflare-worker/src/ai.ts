// Workers AI: Uebersetzung, Kurzbeschreibung, Platten-Einordnung.
import { Env } from "./env";
import { MakerWorldPlate } from "./makerworld";

// Eigene kurze Produktbeschreibung, 1-2 sachliche Saetze (Entscheidung Betreiber 2026-11-14/15): nur aus
// Titel, Tags, Groesse und Teilnamen -- die MakerWorld-Beschreibung wird
// bewusst NICHT verwendet (keine Kopie fremder Texte). Best-effort, null bei
// Fehler; der Admin prueft/aendert den Vorschlag vor dem Anlegen.
export const DESCRIPTION_MAX = 300;

// Prompt bewusst mit echten Umlauten: in ASCII-Umschrift ("fuer") schrieb
// das Modell die Antwort ebenfalls ohne Umlaute (Live-Test 2026-11-15).
export const DESCRIPTION_SYSTEM_PROMPT =
	"Du schreibst Produktbeschreibungen für einen kleinen deutschen Shop für " +
	"3D-gedruckte Deko und Figuren. Schreibe 1 bis 2 kurze, sachliche Sätze auf " +
	"Deutsch, höchstens 200 Zeichen, mit korrekten Umlauten (ä, ö, ü, ß). Nur das " +
	"Nötigste: was es ist, dazu Größe und Teile, falls angegeben. Fehlt eine " +
	"Angabe, lass sie einfach weg: schreibe nie, dass etwas nicht angegeben ist, " +
	"und erwähne Teile nur, wenn es mehrere sind. Keine " +
	"Werbefloskeln (z. B. \"genau das Richtige\", \"charmant\", \"Zauber\"), " +
	"keine Fragen, keine Anrede. Nutze NUR die gegebenen Angaben (Titel, " +
	"Stichwörter, Größe, Teile). Erfinde keine Maße, Materialien, Preise, " +
	"Lieferzeiten oder Eigenschaften. Der Kunde kauft das fertig gedruckte Stück: " +
	"erwähne keine Druckdateien oder Druckeinstellungen. Keine Emojis, keine " +
	"Überschrift, keine Anführungszeichen, keine Aufzählung. Antworte NUR mit dem Text.";

export interface DescriptionInput {
	title: string | null;
	tags: string[];
	sizeHint: string | null;
	parts: string[];
}

export function descriptionPrompt(input: DescriptionInput): string | null {
	const title = input.title?.trim();
	if (!title) return null;
	const lines = [`Titel: ${title}`];
	if (input.tags.length > 0) lines.push(`Stichwörter: ${input.tags.slice(0, 12).join(", ")}`);
	if (input.sizeHint) lines.push(`Größe: ${input.sizeHint}`);
	const parts = Array.from(new Set(input.parts.map((p) => p.trim()).filter(Boolean)));
	if (parts.length > 1) lines.push(`Teile: ${parts.slice(0, 8).join(", ")}`);
	return lines.join("\n");
}

// Nachbearbeitung (Live-Fund 2026-11-15): das Modell schreibt trotz Prompt
// gelegentlich "Groesse nicht angegeben" oder "besteht aus einem Teil".
// Solche Satzteile werden entfernt; bleibt nichts uebrig -> null.
export function cleanDescription(text: string): string | null {
	const sentences = text.match(/[^.!?]+[.!?]?/g) ?? [];
	const out: string[] = [];
	for (const raw of sentences) {
		let s = raw.trim();
		if (!s) continue;
		// Satzteile mit "nicht angegeben/bekannt", "keine Angabe" entfernen
		s = s.replace(/,?\s*[^,.!?]*(nicht angegeben|nicht bekannt|keine angabe|unbekannt)[^,.!?]*/gi, "");
		// "(und) besteht aus einem (einzigen) Teil" entfernen
		s = s.replace(/,?\s*(und\s+)?(sie|er|es|das\s+\S+|die\s+\S+|der\s+\S+)?\s*besteht aus (einem|einem einzigen|1) teil/gi, "");
		s = s.replace(/\s+([.!?])$/, "$1").trim();
		if (!/[a-zäöüß]{3}/i.test(s)) continue;
		if (!/[.!?]$/.test(s)) s += ".";
		out.push(s);
	}
	const joined = out.join(" ").trim();
	return joined.length >= 10 ? joined : null;
}

export async function generateDescriptionDe(env: Env, input: DescriptionInput): Promise<string | null> {
	const prompt = descriptionPrompt(input);
	if (!prompt || !env.AI) return null;
	try {
		const result = (await env.AI.run(TRANSLATION_MODEL, {
			messages: [
				{ role: "system", content: DESCRIPTION_SYSTEM_PROMPT },
				{ role: "user", content: prompt },
			],
			max_tokens: 120,
		})) as { response?: unknown };
		const raw = typeof result?.response === "string" ? result.response.trim() : "";
		const out = decodeHtmlEntities(raw)
			.replace(/^["'„“]+/, "")
			.replace(/["'“”]+$/, "")
			.replace(/\s+/g, " ")
			.trim();
		const cleaned = out ? cleanDescription(out) : null;
		if (!cleaned) return null;
		if (cleaned.length <= DESCRIPTION_MAX) return cleaned;
		// Am letzten Satzende vor der Grenze abschneiden
		const cut = cleaned.slice(0, DESCRIPTION_MAX);
		const end = cut.lastIndexOf(". ");
		return end > 40 ? cut.slice(0, end + 1) : cut.trim();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// KI-Einordnung der Druckplatten (Entscheidung Betreiber 2026-11-15): Vorschlag,
// ob die Platten Teile EINES Stuecks sind (Elch: Koerper + Geweih), Alternativen
// (Pinguin einteilig/zweifarbig, Laterne Motiv 1/2 -> Varianten), einzelne
// Produkte oder einfach alles zusammen. Nur Vorschlag; der Admin bestaetigt.
// Bildbeschreibung: LLaVA (@cf/llava-hf/llava-1.5-7b-hf, ohne Lizenz-
// Zustimmung im Cloudflare-Konto), Einordnung: Llama 3.3 mit JSON-Antwort.
// Fehler jeder Art -> null (Import laeuft ohne Vorschlag).
// ---------------------------------------------------------------------------
export const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

export const ANALYSIS_MAX_PLATES = 8;

export interface PlateAnalysis {
	mode: "parts" | "variants" | "perPlate" | "combined";
	confident: boolean;
	reason: string;
	partNames: Record<string, string>;
	variants: { name: string; plateNos: number[] }[];
	// Bildbeschreibungen je Platte (Nachvollziehbarkeit im Admin)
	captions?: (string | null)[];
}

export async function describePlateImage(env: Env, url: string): Promise<string | null> {
	try {
		const small = url.includes("?") ? url : `${url}?x-oss-process=image/resize,w_336`;
		const res = await fetch(small);
		if (!res.ok) return null;
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (bytes.length === 0 || bytes.length > 2_000_000) return null;
		const out = (await env.AI.run(VISION_MODEL as never, {
			image: [...bytes],
			prompt: "Describe the 3D printed object(s) on this print plate in at most 10 words.",
			max_tokens: 40,
		} as never)) as { description?: unknown };
		const text = typeof out?.description === "string" ? out.description.trim() : "";
		return text ? text.slice(0, 120) : null;
	} catch {
		return null;
	}
}

export const ANALYSIS_SYSTEM_PROMPT =
	"Du ordnest die Druckplatten eines 3D-Druckmodells fuer einen Shop ein. " +
	"Antworte NUR mit JSON: {\"mode\":\"parts|variants|perPlate|combined\",\"confident\":true|false," +
	"\"reason\":\"max. 10 Woerter Deutsch\",\"partNames\":[{\"plate\":1,\"name\":\"Teilname Deutsch\"}]," +
	"\"variants\":[{\"name\":\"Variantenname Deutsch\",\"plates\":[1,3]}]}. " +
	"partNames IMMER fuer jede Platte angeben. Bei mode=variants IMMER mindestens zwei variants mit ihren " +
	"Platten angeben (z. B. Einteilig=[1], Zweifarbig=[2,3]; Motiv 1=[1,3], Motiv 2=[2,3]; Groessen je Platte). " +
	"confident=true, wenn die Hinweise und Bilder klar passen. " +
	"Regeln: parts = alle Platten zusammen ergeben EIN Stueck (z. B. Koerper und Geweih getrennt gedruckt). " +
	"variants = Platten sind Alternativen, der Kunde bekommt nur eine Version (z. B. Pinguin aus einem Stueck " +
	"ODER aus Aussen + Bauch; Motiv 1 oder Motiv 2, jeweils mit demselben Sockel). Gemeinsame Teile wie ein " +
	"Sockel gehoeren in jede Variante; variants nur bei mode=variants. perPlate = verschiedene eigenstaendige " +
	"Figuren (Sammlung). combined = alles zusammen als ein einfarbiges Stueck. Gleiche Gewichte und Zeiten bei " +
	"Platten mit gleichem Motivtyp deuten auf Alternativen hin; eine Platte etwa so schwer wie zwei andere " +
	"zusammen deutet auf eine einteilige Alternative hin. partNames fuer jede Platte, kurz (1-2 Woerter). " +
	"confident=false, wenn du nicht sicher bist.";

// Berechnete Hinweise fuer die KI: gleiche Platten (Alternativen) und eine
// Platte, die etwa so schwer ist wie andere zusammen (einteilige Alternative).
export function plateHints(plates: MakerWorldPlate[]): string[] {
	const hints: string[] = [];
	const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= Math.max(1, b * tol);
	for (let i = 0; i < plates.length; i++) {
		for (let j = i + 1; j < plates.length; j++) {
			const a = plates[i];
			const b = plates[j];
			if (a.weightG !== null && b.weightG !== null && near(a.weightG, b.weightG, 0.05)
				&& a.printMinutes !== null && b.printMinutes !== null && near(a.printMinutes, b.printMinutes, 0.05)) {
				hints.push(`Platte ${a.plateNo} und ${b.plateNo} sind gleich schwer und gleich lang (wahrscheinlich Alternativen, z. B. verschiedene Motive).`);
			}
		}
	}
	if (plates.length >= 3) {
		for (const a of plates) {
			const others = plates.filter((p) => p !== a);
			const sum = others.reduce((s, p) => s + (p.weightG ?? 0), 0);
			if (a.weightG !== null && sum > 0 && near(a.weightG, sum, 0.2)) {
				hints.push(`Platte ${a.plateNo} wiegt etwa so viel wie alle anderen zusammen (evtl. einteilige Alternative zu den anderen).`);
			}
		}
	}
	return hints;
}

export function analysisPrompt(
	title: string,
	plates: MakerWorldPlate[],
	captions: (string | null)[],
): string {
	const lines = [`Modell: ${title}`];
	plates.forEach((p, i) => {
		const parts = [
			`Platte ${p.plateNo}`,
			p.name ? `Name "${p.name}"` : null,
			p.weightG !== null ? `${p.weightG} g` : null,
			p.printMinutes !== null ? `${p.printMinutes} min` : null,
			`${p.filaments.length || 1} Filament(e)`,
			captions[i] ? `Bild: ${captions[i]}` : null,
		].filter(Boolean);
		lines.push(parts.join(", "));
	});
	const hints = plateHints(plates);
	if (hints.length > 0) lines.push(...hints.map((h) => `Hinweis: ${h}`));
	return lines.join("\n");
}

// JSON-Schema fuer die Antwort (Workers AI JSON-Modus)
export const ANALYSIS_SCHEMA = {
	type: "object",
	properties: {
		mode: { type: "string", enum: ["parts", "variants", "perPlate", "combined"] },
		confident: { type: "boolean" },
		reason: { type: "string" },
		partNames: {
			type: "array",
			items: {
				type: "object",
				properties: { plate: { type: "integer" }, name: { type: "string" } },
				required: ["plate", "name"],
			},
		},
		variants: {
			type: "array",
			items: {
				type: "object",
				properties: { name: { type: "string" }, plates: { type: "array", items: { type: "integer" } } },
				required: ["name", "plates"],
			},
		},
	},
	required: ["mode", "confident", "reason", "partNames", "variants"],
};

export function parsePlateAnalysis(raw: string | Record<string, unknown>, plates: MakerWorldPlate[]): PlateAnalysis | null {
	let data: Record<string, unknown>;
	if (typeof raw === "object" && raw !== null) {
		data = raw;
	} else {
		const start = raw.indexOf("{");
		const end = raw.lastIndexOf("}");
		if (start < 0 || end <= start) return null;
		try {
			data = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	const modes = ["parts", "variants", "perPlate", "combined"] as const;
	const mode = modes.find((m) => m === data.mode);
	if (!mode) return null;
	const known = new Set(plates.map((p) => p.plateNo));
	const partNames: Record<string, string> = {};
	if (Array.isArray(data.partNames)) {
		for (const e of data.partNames) {
			if (typeof e !== "object" || e === null) continue;
			const rec = e as Record<string, unknown>;
			const n = Number(rec.plate);
			if (known.has(n) && typeof rec.name === "string" && rec.name.trim()) partNames[String(n)] = rec.name.trim().slice(0, 40);
		}
	} else if (data.partNames && typeof data.partNames === "object") {
		for (const [k, v] of Object.entries(data.partNames as Record<string, unknown>)) {
			const n = Number(k);
			if (known.has(n) && typeof v === "string" && v.trim()) partNames[String(n)] = v.trim().slice(0, 40);
		}
	}
	const variants: { name: string; plateNos: number[] }[] = [];
	if (Array.isArray(data.variants)) {
		for (const v of data.variants) {
			if (typeof v !== "object" || v === null) continue;
			const rec = v as Record<string, unknown>;
			const name = typeof rec.name === "string" ? rec.name.trim().slice(0, 40) : "";
			const nos = Array.isArray(rec.plates)
				? Array.from(new Set(rec.plates.map((x) => Number(x)).filter((n) => known.has(n)))).sort((a, b) => a - b)
				: [];
			if (name && nos.length > 0) variants.push({ name, plateNos: nos });
		}
	}
	let confident = data.confident === true;
	// Varianten ohne mindestens zwei brauchbare Gruppen sind kein Vorschlag
	if (mode === "variants" && variants.length < 2) confident = false;
	const reason = typeof data.reason === "string" ? decodeHtmlEntities(data.reason).trim().slice(0, 120) : "";
	return { mode, confident, reason, partNames, variants: mode === "variants" ? variants : [] };
}

export async function analyzePlates(env: Env, title: string, plates: MakerWorldPlate[]): Promise<PlateAnalysis | null> {
	if (!env.AI || plates.length < 2 || plates.length > ANALYSIS_MAX_PLATES) return null;
	try {
		const captions = await Promise.all(plates.map((p) => (p.imageUrl ? describePlateImage(env, p.imageUrl) : Promise.resolve(null))));
		const result = (await env.AI.run(TRANSLATION_MODEL, {
			messages: [
				{ role: "system", content: ANALYSIS_SYSTEM_PROMPT },
				{ role: "user", content: analysisPrompt(title, plates, captions) },
			],
			max_tokens: 500,
			response_format: { type: "json_schema", json_schema: ANALYSIS_SCHEMA },
		} as never)) as { response?: unknown };
		const raw =
			typeof result?.response === "string"
				? result.response
				: result?.response && typeof result.response === "object"
					? (result.response as Record<string, unknown>)
					: "";
		const analysis = parsePlateAnalysis(raw, plates);
		return analysis ? { ...analysis, captions } : null;
	} catch {
		return null;
	}
}

export const PLATE_NAME_MAX = 60;

export const PLATE_NAME_TRANSLATE_LIMIT = 12;

// Plattennamen einzeln uebersetzen (Komma/& im Namen, daher kein
// Listen-Aufruf wie bei Tags). Gleiche Namen nur einmal, hoechstens 12
// verschiedene je Modell. Fehler -> nameDe bleibt null.
export async function translatePlateNames(env: Env, plates: MakerWorldPlate[]): Promise<MakerWorldPlate[]> {
	const unique = Array.from(new Set(plates.map((p) => p.name).filter((n): n is string => !!n))).slice(
		0,
		PLATE_NAME_TRANSLATE_LIMIT,
	);
	if (unique.length === 0) return plates;
	const translated = await Promise.all(unique.map((n) => translateEnDe(env, n)));
	const byName = new Map(
		unique.map((n, i) => {
			const de = translated[i] ? decodeHtmlEntities(translated[i]!).trim().slice(0, PLATE_NAME_MAX) : "";
			return [n, de || null] as const;
		}),
	);
	return plates.map((p) => ({ ...p, nameDe: p.name ? (byName.get(p.name) ?? null) : null }));
}

// Uebersetzung Englisch -> Deutsch ueber Workers AI (Spec 27 §2). Reiner
// Vorschlag: Fehler (Quota, Binding fehlt, unerwartete Antwort) liefern
// null / leeres Array, nie eine Exception -- der Import laeuft dann mit dem
// Original weiter.
//
// Modellwahl (getestet 2026-09-19 via wrangler dev --remote): das reine
// Uebersetzungsmodell @cf/meta/m2m100-1.2b liefert fuer kurze Produkttitel
// unbrauchbare Ergebnisse ("Tiny Spiky Freund", "hedgehog" -> "Hecke").
// Llama 3.3 70B mit Uebersetzer-Systemprompt trifft es ("Igel", "Gelenkiger
// Drachen-Schluesselanhaenger") bei ca. 5-10 Neurons je Aufruf -- im
// Free-Tier (10.000 Neurons/Tag) reicht das fuer hunderte Modelle am Tag.
// Die Tags werden als eine kommagetrennte Zeile uebersetzt (ein Aufruf
// statt N) und wieder aufgeteilt; passt die Anzahl nicht, gelten die
// uebersetzten Tags als unbrauchbar (leeres Array), damit keine verschobene
// Zuordnung entsteht.
export const TRANSLATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const TRANSLATION_SYSTEM_PROMPT =
	"Du bist Uebersetzer fuer einen deutschen 3D-Druck-Shop. Uebersetze den " +
	"englischen Produkttitel bzw. die Tag-Liste ins Deutsche. Antworte NUR mit " +
	"der Uebersetzung, ohne Erklaerung, ohne Anfuehrungszeichen. Bei einer " +
	"kommagetrennten Liste: gleiche Anzahl Eintraege, kommagetrennt.";

export async function translateEnDe(env: Env, text: string): Promise<string | null> {
	const input = text.trim();
	if (!input || !env.AI) return null;
	try {
		const result = (await env.AI.run(TRANSLATION_MODEL, {
			messages: [
				{ role: "system", content: TRANSLATION_SYSTEM_PROMPT },
				{ role: "user", content: input },
			],
			max_tokens: 160,
		})) as { response?: unknown };
		const raw = typeof result?.response === "string" ? result.response.trim() : "";
		// Modelle setzen gelegentlich Anfuehrungszeichen um die Antwort.
		const out = raw.replace(/^["'\u201e\u201c]+/, "").replace(/["'\u201c\u201d]+$/, "").trim();
		return out || null;
	} catch {
		return null;
	}
}

// Loest auch mehrfach kodierte HTML-Entities auf (z. B. "&amp;#39;" ->
// "'"), falls MakerWorld-Tags oder das Uebersetzungsmodell welche liefern
// (Fund 2026-09-21: Tags wie "&amp;#39;decor" landeten unveraendert im
// Katalog-Filter). Wiederholtes Ersetzen bis stabil deckt Mehrfachkodierung ab.
export function decodeHtmlEntities(text: string): string {
	let value = text;
	for (let i = 0; i < 5; i++) {
		const before = value;
		value = value
			.replace(/&amp;/g, "&")
			.replace(/&#39;|&apos;/g, "'")
			.replace(/&quot;/g, '"')
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">");
		if (value === before) break;
	}
	return value;
}

export async function translateTagsEnDe(env: Env, tags: string[]): Promise<string[]> {
	if (tags.length === 0) return [];
	const joined = await translateEnDe(env, tags.join(", "));
	if (!joined) return [];
	const parts = joined
		.split(/\s*,\s*/)
		.map((t) => decodeHtmlEntities(t).trim().toLowerCase())
		.filter((t) => t.length > 0);
	if (parts.length !== tags.length) return [];
	return Array.from(new Set(parts));
}
