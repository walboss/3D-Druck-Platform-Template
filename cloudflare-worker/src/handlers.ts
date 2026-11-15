// Endpunkt-Handler (oeffentlich und Admin).
import { Env } from "./env";
import { jsonResponse } from "./http";
import { callSupabaseRpc, fetchDefaultPrinter, verifyAdminToken, verifyTurnstile } from "./supabase";
import { sanitizeCustomRequestPayload } from "./payloads";
import { extractMakerWorldModelId, fetchMakerWorldEstimates } from "./makerworld";
import { DescriptionInput, analyzePlates, generateDescriptionDe, translateEnDe, translatePlateNames, translateTagsEnDe } from "./ai";

export async function handleTurnstileGatedRpc(
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

export async function handleImportMakerworld(request: Request, env: Env): Promise<Response> {
	const authHeader = request.headers.get("Authorization") ?? "";
	const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!tokenMatch) {
		return jsonResponse({ error: "Authorization-Header (Bearer-Token) fehlt" }, 401);
	}
	if (!(await verifyAdminToken(env, tokenMatch[1]))) {
		return jsonResponse({ error: "Ungueltiger oder abgelaufener Admin-Token" }, 401);
	}

	let body: { makerworldUrl?: unknown; profileId?: unknown };
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

	const targetPrinter = await fetchDefaultPrinter(env, tokenMatch[1]);
	const profileId = typeof body.profileId === "number" && body.profileId > 0 ? body.profileId : null;
	const estimatesResult = await fetchMakerWorldEstimates(idResult.id, targetPrinter, profileId);
	if (!estimatesResult.ok) {
		return jsonResponse({ error: estimatesResult.error }, 400);
	}
	const estimates = estimatesResult.estimates;

	// Uebersetzung parallel, best-effort (Spec 27 §2/§4).
	const [titleDe, tagsDe, plates] = await Promise.all([
		estimates.title ? translateEnDe(env, estimates.title) : Promise.resolve(null),
		translateTagsEnDe(env, estimates.tags),
		translatePlateNames(env, estimates.plates),
	]);
	// Beschreibung und Platten-Einordnung brauchen die deutschen Werte, daher danach.
	const descriptionPromise = generateDescriptionDe(env, {
		title: titleDe ?? estimates.title,
		tags: tagsDe.length > 0 ? tagsDe : estimates.tags,
		sizeHint: estimates.sizeHint ?? null,
		parts: plates.map((p) => p.nameDe ?? p.name ?? ""),
	});
	const [descriptionDe, plateAnalysis] = await Promise.all([
		descriptionPromise,
		analyzePlates(env, titleDe ?? estimates.title ?? "", plates),
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
			descriptionDe,
			plateAnalysis,
			category: estimates.category,
			sizeHint: estimates.sizeHint,
			plates,
			profiles: estimates.profiles,
			printProfile: estimates.printProfile,
			modelId: idResult.id,
			sourceUrl: body.makerworldUrl.trim(),
		},
		200,
	);
}

// Beschreibung fuer ein bestehendes Produkt (Katalogpflege "Beschreibungen
// ergaenzen", Entscheidung Betreiber 2026-11-15). Eingaben aus der eigenen DB
// (Name, Tags, Groesse, Teile), gleicher Prompt wie beim Import.
export function parseDescriptionRequest(body: unknown): DescriptionInput | null {
	if (typeof body !== "object" || body === null) return null;
	const b = body as Record<string, unknown>;
	const title = typeof b.title === "string" ? b.title.trim().slice(0, 200) : "";
	if (!title) return null;
	const strings = (v: unknown, max: number): string[] =>
		Array.isArray(v)
			? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 60)).filter(Boolean).slice(0, max)
			: [];
	const size = typeof b.sizeHint === "string" ? b.sizeHint.trim().slice(0, 60) : "";
	return { title, tags: strings(b.tags, 12), sizeHint: size || null, parts: strings(b.parts, 8) };
}

export async function handleBeschreibung(request: Request, env: Env): Promise<Response> {
	const authHeader = request.headers.get("Authorization") ?? "";
	const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!tokenMatch) {
		return jsonResponse({ error: "Authorization-Header (Bearer-Token) fehlt" }, 401);
	}
	if (!(await verifyAdminToken(env, tokenMatch[1]))) {
		return jsonResponse({ error: "Ungueltiger oder abgelaufener Admin-Token" }, 401);
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: "Ungueltiger JSON-Body" }, 400);
	}
	const input = parseDescriptionRequest(body);
	if (!input) {
		return jsonResponse({ error: "title fehlt" }, 400);
	}
	const description = await generateDescriptionDe(env, input);
	if (!description) {
		return jsonResponse({ error: "Beschreibung konnte nicht erzeugt werden" }, 502);
	}
	return jsonResponse({ description }, 200);
}

export async function handleIndividualanfrage(request: Request, env: Env): Promise<Response> {
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

	let parsed: unknown;
	try {
		parsed = JSON.parse(requestPayloadRaw);
	} catch {
		return jsonResponse({ error: "requestPayload ist kein gueltiges JSON-Objekt" }, 400);
	}
	const payload = sanitizeCustomRequestPayload(parsed);
	if (payload === null) {
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
export const SUGGESTION_NOTE_MAX_LENGTH = 500;

export type SuggestionStatus = "angelegt" | "bereits_vorgeschlagen" | "bereits_im_katalog";

export async function handleVorschlag(request: Request, env: Env): Promise<Response> {
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
export const CUSTOMER_SEARCH_MAX_LENGTH = 200;

export function optionalSearchField(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length > CUSTOMER_SEARCH_MAX_LENGTH) return undefined;
	return trimmed || null;
}

export async function handleKundensuche(request: Request, env: Env): Promise<Response> {
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
