# Admin: Login

**Datenquelle:** Supabase Auth (E-Mail/Passwort + Google-OAuth-Provider)

**Elemente:**
- E-Mail/Passwort-Formular
- "Mit Google anmelden"-Button (supabase.auth.signInWithOAuth, provider: google)
- Beide Wege führen zum selben, einzigen Admin-Konto (identische E-Mail-Adresse)
- Keine Registrierung möglich (Neuanmeldungen serverseitig deaktiviert) — kein
  "Konto erstellen"-Link im UI, das wäre irreführend

**Zustände:** Ladezustand während Auth-Check, Fehlermeldung bei falschem
Passwort/abgebrochenem Google-Flow (allgemein gehalten, kein Enumerations-Leck
über "Account existiert nicht" vs. "Passwort falsch")
