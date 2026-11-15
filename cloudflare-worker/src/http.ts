// HTTP-Hilfen: CORS, JSON-Antworten, Body-Grenze (Review D31).

// Access-Control-Allow-Origin wird nicht hier, sondern pro Request in
// withCors() gesetzt — nur fuer Origins aus ALLOWED_ORIGINS.
export const ALLOWED_ORIGINS = new Set<string>([
	"https://3d-druck-platform.DEINE-SUBDOMAIN.workers.dev",
	// Lokale Entwicklung (ng serve)
	"http://localhost:4200",
]);

export const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	// Authorization: fuer /api/admin/import-makerworld (Bearer-Token), siehe unten.
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

// Technische Obergrenze fuer Request-Bodies der oeffentlichen Endpunkte
// (Schutz vor Missbrauch; echte Formulare sind weit kleiner).
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Liest den Body hoechstens bis maxBytes mit und gibt einen neuen Request mit
 * gepuffertem Body zurueck; null = zu gross (Review D31: vorher nur der
 * Content-Length-Header geprueft, ein Request ohne/mit falschem Header kam
 * beliebig gross durch).
 */
export async function limitBody(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<Request | null> {
	const declared = Number(request.headers.get("Content-Length"));
	if (Number.isFinite(declared) && declared > maxBytes) return null;
	if (!request.body) return request;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		body.set(c, offset);
		offset += c.byteLength;
	}
	return new Request(request.url, { method: request.method, headers: request.headers, body });
}

// Setzt Access-Control-Allow-Origin genau dann, wenn der Origin des Requests
// auf der Allowlist steht; sonst fehlt der Header und der Browser blockiert.
export function withCors(response: Response, request: Request): Response {
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
