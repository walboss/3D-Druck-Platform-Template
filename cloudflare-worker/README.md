# 3D-Druck-Platform API Worker

Cloudflare Worker: Turnstile-Verifikation vorgeschaltet vor `fn_place_order`
und `fn_submit_custom_request` (Supabase RPC).

## Setup

```bash
npm install
```

Secrets setzen (Eingabe wird danach abgefragt):

```bash
wrangler secret put TURNSTILE_SECRET_KEY
```
Secret Key aus dem Turnstile-Widget eintragen.

```bash
wrangler secret put SUPABASE_ANON_KEY
```
Anon Key aus Supabase Project Settings → API eintragen.

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```
Service Role Key aus Supabase Project Settings → API eintragen. Wird nur
serverseitig für die RPC-Aufrufe nach bestandener Turnstile-Prüfung verwendet
(`fn_place_order`, `fn_submit_custom_request`, `fn_customer_search`,
`fn_submit_product_suggestion` — für anon gesperrt, Migrationen 00161/00191/
00192), nie an den Client weitergegeben.

## Deploy

```bash
wrangler deploy
```

## Lokal testen

```bash
npm run dev
```
