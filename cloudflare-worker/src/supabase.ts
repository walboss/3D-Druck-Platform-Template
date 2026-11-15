// Supabase/Turnstile: RPC-Aufrufe, Bot-Schutz, Admin-Pruefung.
import { Env } from "./env";
import { CORS_HEADERS, jsonResponse } from "./http";
import { TargetPrinter } from "./makerworld";

export interface TurnstileVerifyResult {
	success: boolean;
}

export async function verifyTurnstile(
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
export async function callSupabaseRpc(
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
export const CUSTOMER_ERROR_BY_HINT: Record<string, string> = {
	shop_disabled: "Bestellungen sind gerade deaktiviert. Bitte versuche es später erneut.",
	custom_request_disabled: "Individualanfragen sind gerade deaktiviert. Bitte versuche es später erneut.",
	message_too_long: "Die Anmerkung ist zu lang (höchstens 500 Zeichen).",
};

export const CUSTOMER_ERROR_DEFAULT =
	"Das hat leider nicht geklappt. Bitte prüfe deine Angaben und versuche es erneut.";

export async function customerErrorMessage(response: Response): Promise<string> {
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

// Standard-Drucker (Migration 00186) mit dem Admin-Token der Anfrage lesen.
// Fehler -> null (Import laeuft dann wie frueher mit dem ersten Profil).
export async function fetchDefaultPrinter(env: Env, token: string): Promise<TargetPrinter | null> {
	try {
		const response = await fetch(
			`${env.SUPABASE_URL}/rest/v1/printers?select=name,model&is_default=eq.true&active=eq.true&limit=1`,
			{ headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } },
		);
		if (!response.ok) return null;
		const rows = (await response.json()) as { name?: unknown; model?: unknown }[];
		const row = Array.isArray(rows) ? rows[0] : undefined;
		if (!row || typeof row.name !== "string" || !row.name.trim()) return null;
		return { name: row.name.trim(), model: typeof row.model === "string" && row.model.trim() ? row.model.trim() : null };
	} catch {
		return null;
	}
}

// Liest die Claims eines JWT OHNE Signaturpruefung -- nur zulaessig, nachdem
// Supabase Auth den Token bereits akzeptiert hat (siehe verifyAdminToken).
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
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
export async function verifyAdminToken(env: Env, token: string): Promise<boolean> {
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
