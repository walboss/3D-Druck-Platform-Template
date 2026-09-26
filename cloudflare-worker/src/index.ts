export interface Env {
	SUPABASE_URL: string;
	SUPABASE_ANON_KEY: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	TURNSTILE_SECRET_KEY: string;
	// Workers-AI-Binding (wrangler.toml [ai]) fuer die Uebersetzung der
	// MakerWorld-Titel/-Tags, specs/27-makerworld-import-vorschlaege.md §2.
	AI: Ai;
	// Rate-Limiting-Binding (wrangler.toml [[ratelimits]]) fuer /api/kundensuche,
	// OFFENE-SECURITY-FIXES.md §5.
	KUNDENSUCHE_LIMITER: RateLimit;
}

// Access-Control-Allow-Origin wird nicht hier, sondern pro Request in
// withCors() gesetzt — nur fuer Origins aus ALLOWED_ORIGINS.
const ALLOWED_ORIGINS = new Set<string>([
	"https://3d-druck-platform.DEINE-SUBDOMAIN.workers.dev",
	// Lokale Entwicklung (ng serve)
	"http://localhost:4200",
]);

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	// Authorization: fuer /api/admin/import-makerworld (Bearer-Token), siehe unten.
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

interface TurnstileVerifyResult {
	success: boolean;
}

async function verifyTurnstile(
	token: string,
	secretKey: string,
	remoteIp: string | null,
): Promise<boolean> {
	const formData = new FormData();
	formData.append("secret", secretKey);
	formData.append("response", token);
	if (remoteIp) {
		formData.append("remoteip", remoteIp);
	}

	// Netzwerk-/Parse-Fehler bei Cloudflare -> wie fehlgeschlagene Pruefung
	// (403 statt unbehandelter Exception / 500).
	try {
		const verifyResponse = await fetch(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{ method: "POST", body: formData },
		);
		const result = (await verifyResponse.json()) as TurnstileVerifyResult;
		return result?.success === true;
	} catch {
		return false;
	}
}

// Aufruf mit service_role: fn_place_order und fn_submit_custom_request sind
// seit Migration 00192 nicht mehr fuer anon freigegeben, damit Turnstile
// nicht per Direktaufruf der Supabase-REST-API umgangen werden kann.
async function callSupabaseRpc(
	env: Env,
	functionName: string,
	payload: unknown,
): Promise<Response> {
	const supabaseResponse = await fetch(
		`${env.SUPABASE_URL}/rest/v1/rpc/${functionName}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				apikey: env.SUPABASE_SERVICE_ROLE_KEY,
				Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
			},
			body: JSON.stringify(payload),
		},
	);

	if (!supabaseResponse.ok) {
		return jsonResponse({ error: await customerErrorMessage(supabaseResponse) }, supabaseResponse.status >= 500 ? 502 : 400);
	}

	return new Response(supabaseResponse.body, {
		status: supabaseResponse.status,
		headers: {
			"Content-Type":
				supabaseResponse.headers.get("Content-Type") ?? "application/json",
			...CORS_HEADERS,
		},
	});
}

// Datenbank-Fehlertexte (z. B. "fn_place_order: ...") nicht an Kunden
// durchreichen: bekannte Faelle (Hint aus Migration 00193) in einen
// verstaendlichen Text uebersetzen, alles andere allgemein halten.
const CUSTOMER_ERROR_BY_HINT: Record<string, string> = {
	shop_disabled: "Bestellungen sind gerade deaktiviert. Bitte versuche es später erneut.",
	custom_request_disabled: "Individualanfragen sind gerade deaktiviert. Bitte versuche es später erneut.",
	message_too_long: "Die Anmerkung ist zu lang (höchstens 500 Zeichen).",
};
const CUSTOMER_ERROR_DEFAULT =
	"Das hat leider nicht geklappt. Bitte prüfe deine Angaben und versuche es erneut.";

async function customerErrorMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { hint?: unknown };
		if (typeof body?.hint === "string" && CUSTOMER_ERROR_BY_HINT[body.hint]) {
			return CUSTOMER_ERROR_BY_HINT[body.hint];
		}
	} catch {
		// kein JSON -> allgemeiner Text
	}
	return CUSTOMER_ERROR_DEFAULT;
}

// Nur die bekannten Parameter von fn_place_order weiterreichen.
// existing_customer_id wird entfernt: das Storefront nutzt es nicht, und
// ein anonymer Aufrufer koennte damit sonst auf einen fremden Kunden bestellen.
function sanitizeOrderPayload(payload: unknown): Record<string, unknown> | null {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const { p_cart_session_id, p_customer } = payload as Record<string, unknown>;
	if (typeof p_customer !== "object" || p_customer === null || Array.isArray(p_customer)) return null;
	const { existing_customer_id: _ignored, ...customer } = p_customer as Record<string, unknown>;
	return { p_cart_session_id, p_customer: customer };
}

async function handleTurnstileGatedRpc(
	request: Request,
	env: Env,
	payloadField: string,
	functionName: string,
	sanitize: (payload: unknown) => Record<string, unknown> | null,
): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: "Ungueltiger JSON-Body" }, 400);
	}

	const turnstileToken = body.turnstileToken;
	const payload = body[payloadField] === undefined ? undefined : sanitize(body[payloadField]);

	if (typeof turnstileToken !== "string" || !turnstileToken) {
		return jsonResponse({ error: "turnstileToken fehlt" }, 400);
	}
	if (payload === undefined) {
		return jsonResponse({ error: `${payloadField} fehlt` }, 400);
	}
	if (payload === null) {
		return jsonResponse({ error: `${payloadField} ist ungueltig` }, 400);
	}

	const remoteIp = request.headers.get("CF-Connecting-IP");
	const turnstileOk = await verifyTurnstile(
		turnstileToken,
		env.TURNSTILE_SECRET_KEY,
		remoteIp,
	);

	if (!turnstileOk) {
		return jsonResponse({ error: "Turnstile-Verifikation fehlgeschlagen" }, 403);
	}

	return callSupabaseRpc(env, functionName, payload);
}

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
const MAKERWORLD_HOST_SUFFIX = "makerworld.com";
const MAKERWORLD_MODEL_ID_PATTERN = /\/models\/(\d+)(?:[/?#-]|$)/;

interface MakerWorldEstimates {
	estimatedPrintMinutes: number | null;
	estimatedWeightG: number | null;
	// Titel- und Bild-Vorschlaege fuer die Produkt-Stammdaten (null / leeres
	// Array, wenn die API nichts liefert -- kein Fehlerfall).
	title: string | null;
	images: string[];
	// Spec 27 §4: Tags, erste Kategorie (categories[0].name) und Modell-ID.
	tags: string[];
	category: string | null;
	// 00198: Druckplatten des ersten Druckprofils (instances[0].extention.
	// modelInfo.plates) mit Zeit, Gewicht, Vorschaubild und Filamenten.
	plates: MakerWorldPlate[];
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
}

function toNumber(value: unknown): number | null {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
	return Number.isFinite(n) ? n : null;
}

function plateImageUrl(plate: Record<string, unknown>): string | null {
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
		plates.push({
			plateNo: index !== null && index >= 1 ? Math.round(index) : i + 1,
			printMinutes: seconds !== null && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null,
			weightG: weight !== null && weight > 0 ? weight : null,
			imageUrl: plateImageUrl(plate),
			filaments,
		});
	});
	return plates;
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
const TRANSLATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TRANSLATION_SYSTEM_PROMPT =
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

// Liest die Claims eines JWT OHNE Signaturpruefung -- nur zulaessig, nachdem
// Supabase Auth den Token bereits akzeptiert hat (siehe verifyAdminToken).
function decodeJwtClaims(token: string): Record<string, unknown> | null {
	const part = token.split(".")[1];
	if (!part) return null;
	try {
		const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
		const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
		const claims = JSON.parse(new TextDecoder().decode(bytes));
		return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

// Verifiziert den Bearer-Token gegen Supabase Auth (GET /auth/v1/user).
// Gueltiger, nicht abgelaufener Token mit Assurance-Stufe aal2 (Passwort +
// TOTP) und aktivem admins-Eintrag -> true. aal2 wie in der DB per db_pre_request erzwungen (Migration
// 00162), damit dieser Endpoint nicht mit reinem Passwort-Login nutzbar ist.
// Weitere Rechte regeln authenticated-Grants/RLS wie bei jedem anderen
// eingeloggten Aufruf aus dem Frontend.
async function verifyAdminToken(env: Env, token: string): Promise<boolean> {
	try {
		const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
			headers: {
				apikey: env.SUPABASE_ANON_KEY,
				Authorization: `Bearer ${token}`,
			},
		});
		if (!response.ok) return false;
	} catch {
		return false;
	}
	const claims = decodeJwtClaims(token);
	if (claims?.role !== "authenticated" || claims?.aal !== "aal2") return false;

	// Zusaetzlich Eintrag in admins verlangen (Migration 00190): fn_is_admin mit
	// dem Token des Nutzers aufrufen. db_pre_request lehnt Nicht-Admins schon
	// vorher ab (-> kein 2xx), sonst muss die Antwort genau true sein.
	try {
		const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/fn_is_admin`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				apikey: env.SUPABASE_ANON_KEY,
				Authorization: `Bearer ${token}`,
			},
			body: "{}",
		});
		if (!response.ok) return false;
		return (await response.json()) === true;
	} catch {
		return false;
	}
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

// Ruft die MakerWorld-Design-API ab und liest Druckzeit/Gewicht des ersten
// Instance-Eintrags (= "erstes/primaeres Druckprofil", wie auf der
// Modellseite an oberster Stelle gezeigt). prediction ist in Sekunden, weight
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
		designExtension?: { design_pictures?: { url?: unknown }[] };
		instances?: { prediction?: unknown; weight?: unknown; extention?: unknown }[];
	};
	try {
		data = await response.json();
	} catch {
		return { ok: false, error: "MakerWorld-Antwort konnte nicht gelesen werden" };
	}

	const firstInstance = Array.isArray(data.instances) ? data.instances[0] : undefined;
	const predictionSeconds = typeof firstInstance?.prediction === "number" ? firstInstance.prediction : null;
	const weightG = typeof firstInstance?.weight === "number" ? firstInstance.weight : null;

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
			estimatedPrintMinutes:
				predictionSeconds !== null && predictionSeconds > 0 ? Math.round(predictionSeconds / 60) : null,
			estimatedWeightG: weightG !== null && weightG > 0 ? weightG : null,
			title,
			images,
			tags,
			category,
			plates: parseMakerWorldPlates(firstInstance),
		},
	};
}

async function handleImportMakerworld(request: Request, env: Env): Promise<Response> {
	const authHeader = request.headers.get("Authorization") ?? "";
	const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!tokenMatch) {
		return jsonResponse({ error: "Authorization-Header (Bearer-Token) fehlt" }, 401);
	}
	if (!(await verifyAdminToken(env, tokenMatch[1]))) {
		return jsonResponse({ error: "Ungueltiger oder abgelaufener Admin-Token" }, 401);
	}

	let body: { makerworldUrl?: unknown };
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: "Ungueltiger JSON-Body" }, 400);
	}
	if (typeof body.makerworldUrl !== "string" || !body.makerworldUrl.trim()) {
		return jsonResponse({ error: "makerworldUrl fehlt" }, 400);
	}

	const idResult = extractMakerWorldModelId(body.makerworldUrl.trim());
	if (!idResult.ok) {
		return jsonResponse({ error: idResult.error }, 400);
	}

	const estimatesResult = await fetchMakerWorldEstimates(idResult.id);
	if (!estimatesResult.ok) {
		return jsonResponse({ error: estimatesResult.error }, 400);
	}
	const estimates = estimatesResult.estimates;

	// Uebersetzung parallel, best-effort (Spec 27 §2/§4).
	const [titleDe, tagsDe] = await Promise.all([
		estimates.title ? translateEnDe(env, estimates.title) : Promise.resolve(null),
		translateTagsEnDe(env, estimates.tags),
	]);

	return jsonResponse(
		{
			estimatedPrintMinutes: estimates.estimatedPrintMinutes,
			estimatedWeightG: estimates.estimatedWeightG,
			title: estimates.title,
			titleDe,
			images: estimates.images,
			tags: estimates.tags,
			tagsDe,
			category: estimates.category,
			plates: estimates.plates,
			modelId: idResult.id,
			sourceUrl: body.makerworldUrl.trim(),
		},
		200,
	);
}

async function handleIndividualanfrage(request: Request, env: Env): Promise<Response> {
	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return jsonResponse({ error: "Ungueltiger multipart/form-data-Body" }, 400);
	}

	const turnstileToken = formData.get("turnstileToken");
	const requestPayloadRaw = formData.get("requestPayload");

	if (typeof turnstileToken !== "string" || !turnstileToken) {
		return jsonResponse({ error: "turnstileToken fehlt" }, 400);
	}
	if (typeof requestPayloadRaw !== "string" || !requestPayloadRaw) {
		return jsonResponse({ error: "requestPayload fehlt" }, 400);
	}

	let payload: Record<string, unknown>;
	try {
		const parsed = JSON.parse(requestPayloadRaw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("kein Objekt");
		}
		payload = parsed as Record<string, unknown>;
	} catch {
		return jsonResponse({ error: "requestPayload ist kein gueltiges JSON-Objekt" }, 400);
	}

	const remoteIp = request.headers.get("CF-Connecting-IP");
	const turnstileOk = await verifyTurnstile(
		turnstileToken,
		env.TURNSTILE_SECRET_KEY,
		remoteIp,
	);

	if (!turnstileOk) {
		return jsonResponse({ error: "Turnstile-Verifikation fehlgeschlagen" }, 403);
	}

	// Das Formular sendet keine Dateien (nur einen optionalen Bild-Link in
	// p_own_image). Storage-Pfad und 3mf-Schaetzwerte daher nie aus dem
	// Client-Payload uebernehmen.
	payload.p_slice_file_upload = null;
	payload.p_estimated_weight_g = null;
	payload.p_estimated_print_minutes = null;

	return callSupabaseRpc(env, "fn_submit_custom_request", payload);
}

// ---------------------------------------------------------------------------
// /api/vorschlag (Spec 27 §4): Kunde ohne Login reicht einen MakerWorld-Link
// als Modellvorschlag ein. Turnstile-geschuetzt wie Checkout/Individualanfrage.
// Bewusst KEIN MakerWorld-Abruf hier (kein Titel fuer den Kunden), damit der
// anonyme Pfad billig bleibt und nicht als Proxy fuer Fremdabrufe taugt.
// Der RPC-Aufruf laeuft mit dem Service-Role-Key: fn_submit_product_suggestion
// hat EXECUTE nur fuer service_role (Migration 00161), anon kann die Funktion
// nicht direkt aufrufen -- Einreichung ausschliesslich ueber diesen Endpoint.
// ---------------------------------------------------------------------------
const SUGGESTION_NOTE_MAX_LENGTH = 500;

type SuggestionStatus = "angelegt" | "bereits_vorgeschlagen" | "bereits_im_katalog";

async function handleVorschlag(request: Request, env: Env): Promise<Response> {
	let body: { turnstileToken?: unknown; makerworldUrl?: unknown; note?: unknown };
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: "Ungueltiger JSON-Body" }, 400);
	}

	if (typeof body.turnstileToken !== "string" || !body.turnstileToken) {
		return jsonResponse({ error: "turnstileToken fehlt" }, 400);
	}
	if (typeof body.makerworldUrl !== "string" || !body.makerworldUrl.trim()) {
		return jsonResponse({ error: "makerworldUrl fehlt" }, 400);
	}
	const makerworldUrl = body.makerworldUrl.trim();
	const idResult = extractMakerWorldModelId(makerworldUrl);
	if (!idResult.ok) {
		return jsonResponse({ error: idResult.error }, 400);
	}

	let note: string | null = null;
	if (body.note !== undefined && body.note !== null) {
		if (typeof body.note !== "string") {
			return jsonResponse({ error: "note muss Text sein" }, 400);
		}
		note = body.note.trim() || null;
		if (note !== null && note.length > SUGGESTION_NOTE_MAX_LENGTH) {
			return jsonResponse({ error: `note darf hoechstens ${SUGGESTION_NOTE_MAX_LENGTH} Zeichen haben` }, 400);
		}
	}

	const remoteIp = request.headers.get("CF-Connecting-IP");
	const turnstileOk = await verifyTurnstile(body.turnstileToken, env.TURNSTILE_SECRET_KEY, remoteIp);
	if (!turnstileOk) {
		return jsonResponse({ error: "Turnstile-Verifikation fehlgeschlagen" }, 403);
	}

	let rpcResponse: Response;
	try {
		rpcResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/fn_submit_product_suggestion`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				apikey: env.SUPABASE_SERVICE_ROLE_KEY,
				Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
			},
			body: JSON.stringify({
				p_makerworld_url: makerworldUrl,
				p_makerworld_model_id: idResult.id,
				p_note: note,
			}),
		});
	} catch {
		return jsonResponse({ error: "Datenbank nicht erreichbar" }, 502);
	}

	if (!rpcResponse.ok) {
		// Fehlertext der DB nicht 1:1 an anonyme Nutzer durchreichen.
		return jsonResponse({ error: "Vorschlag konnte nicht gespeichert werden" }, 502);
	}

	let status: unknown;
	try {
		status = await rpcResponse.json();
	} catch {
		return jsonResponse({ error: "Unerwartete Antwort der Datenbank" }, 502);
	}
	if (status !== "angelegt" && status !== "bereits_vorgeschlagen" && status !== "bereits_im_katalog") {
		return jsonResponse({ error: "Unerwartete Antwort der Datenbank" }, 502);
	}

	return jsonResponse({ status: status as SuggestionStatus }, 200);
}

// POST /api/kundensuche — aktive Kundensuche im Checkout
// (specs/kunden-warenkorb-tracking.md §3, OFFENE-SECURITY-FIXES.md §5).
// fn_customer_search ist seit Migration 00191 nicht mehr fuer anon
// aufrufbar: Rate-Limit pro IP + Turnstile, dann Aufruf mit service_role.
// Antwort bleibt wie bisher nur ja/nein ({ found }), nie Kundendaten.
const CUSTOMER_SEARCH_MAX_LENGTH = 200;

function optionalSearchField(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length > CUSTOMER_SEARCH_MAX_LENGTH) return undefined;
	return trimmed || null;
}

async function handleKundensuche(request: Request, env: Env): Promise<Response> {
	const remoteIp = request.headers.get("CF-Connecting-IP");
	const { success } = await env.KUNDENSUCHE_LIMITER.limit({ key: remoteIp ?? "unbekannt" });
	if (!success) {
		return jsonResponse({ error: "Zu viele Anfragen, bitte kurz warten" }, 429);
	}

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: "Ungueltiger JSON-Body" }, 400);
	}

	const turnstileToken = body.turnstileToken;
	if (typeof turnstileToken !== "string" || !turnstileToken) {
		return jsonResponse({ error: "turnstileToken fehlt" }, 400);
	}
	const phone = optionalSearchField(body.phone);
	const email = optionalSearchField(body.email);
	if (phone === undefined || email === undefined) {
		return jsonResponse({ error: "phone/email muessen Text sein (max. 200 Zeichen)" }, 400);
	}
	if (phone === null && email === null) {
		return jsonResponse({ error: "phone oder email fehlt" }, 400);
	}

	const turnstileOk = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, remoteIp);
	if (!turnstileOk) {
		return jsonResponse({ error: "Turnstile-Verifikation fehlgeschlagen" }, 403);
	}

	let rpcResponse: Response;
	try {
		rpcResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/fn_customer_search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				apikey: env.SUPABASE_SERVICE_ROLE_KEY,
				Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
			},
			body: JSON.stringify({ p_phone: phone, p_email: email }),
		});
	} catch {
		return jsonResponse({ error: "Datenbank nicht erreichbar" }, 502);
	}
	if (!rpcResponse.ok) {
		return jsonResponse({ error: "Kundensuche fehlgeschlagen" }, 502);
	}

	const found = (await rpcResponse.json().catch(() => null)) === true;
	return jsonResponse({ found }, 200);
}

// Setzt Access-Control-Allow-Origin genau dann, wenn der Origin des Requests
// auf der Allowlist steht; sonst fehlt der Header und der Browser blockiert.
function withCors(response: Response, request: Request): Response {
	const headers = new Headers(response.headers);
	const origin = request.headers.get("Origin");
	if (origin !== null && ALLOWED_ORIGINS.has(origin)) {
		headers.set("Access-Control-Allow-Origin", origin);
	} else {
		headers.delete("Access-Control-Allow-Origin");
	}
	headers.append("Vary", "Origin");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return withCors(await route(request, env), request);
	},
};

async function route(request: Request, env: Env): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	const url = new URL(request.url);

	// /api/checkout ist ein Alias fuer /api/wunschliste, gleicher Handler:
	// specs/privatmodus-schalter.md §6.3b, Frontend waehlt den Pfad
	// flag-abhaengig (PricingService.apiEndpointPath), nur im Netzwerk-Tab sichtbar.
	if (request.method === "POST" && (url.pathname === "/api/wunschliste" || url.pathname === "/api/checkout")) {
		return handleTurnstileGatedRpc(
			request,
			env,
			"orderPayload",
			"fn_place_order",
			sanitizeOrderPayload,
		);
	}

	if (request.method === "POST" && url.pathname === "/api/individualanfrage") {
		return handleIndividualanfrage(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/kundensuche") {
		return handleKundensuche(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/vorschlag") {
		return handleVorschlag(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/admin/import-makerworld") {
		return handleImportMakerworld(request, env);
	}

	return jsonResponse({ error: "Not found" }, 404);
}
