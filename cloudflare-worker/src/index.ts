// API-Worker: Einstieg und Router. Logik liegt in den Modulen (Review D31).
import { Env } from "./env";
import { CORS_HEADERS, MAX_BODY_BYTES, jsonResponse, limitBody, withCors } from "./http";
import { sanitizeOrderPayload } from "./payloads";
import { handleBeschreibung, handleImportMakerworld, handleIndividualanfrage, handleKundensuche, handleTurnstileGatedRpc, handleVorschlag } from "./handlers";

export * from "./env";
export * from "./http";
export * from "./supabase";
export * from "./payloads";
export * from "./makerworld";
export * from "./ai";
export * from "./handlers";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return withCors(await route(request, env), request);
	},
};

// Oeffentliche Endpunkte mit Rate-Limit (Kundensuche hat ein eigenes, strengeres)
const PUBLIC_LIMITED_PATHS = new Set(["/api/wunschliste", "/api/checkout", "/api/individualanfrage", "/api/vorschlag"]);

async function route(request: Request, env: Env): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	const url = new URL(request.url);

	if (request.method === "POST") {
		const limited = await limitBody(request, MAX_BODY_BYTES);
		if (!limited) {
			return jsonResponse({ error: "Anfrage zu gross" }, 413);
		}
		request = limited;

		// Oeffentliche Schreib-Endpunkte zusaetzlich je IP begrenzen
		if (PUBLIC_LIMITED_PATHS.has(url.pathname)) {
			const ip = request.headers.get("CF-Connecting-IP") ?? "unbekannt";
			const { success } = await env.API_LIMITER.limit({ key: `${ip}:${url.pathname}` });
			if (!success) {
				return jsonResponse({ error: "Zu viele Anfragen – bitte kurz warten." }, 429);
			}
		}
	}

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

	if (request.method === "POST" && url.pathname === "/api/admin/beschreibung") {
		return handleBeschreibung(request, env);
	}

	return jsonResponse({ error: "Not found" }, 404);
}
