// Umgebung des API-Workers (Bindings, Secrets, Variablen).

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
	// Rate-Limit fuer die uebrigen oeffentlichen Endpunkte (Bestellung/
	// Wunschliste, Individualanfrage, Vorschlag), je IP und Pfad (Review D31).
	API_LIMITER: RateLimit;
}
