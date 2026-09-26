// Link-Vorschau für Produktseiten (Entscheidung 2026-09-24).
//
// Läuft NUR für /produkt/* (wrangler.toml: run_worker_first), alles andere
// liefert Cloudflare direkt als statische Dateien aus. Für eine gültige
// Produkt-ID werden Name, Beschreibung und erstes Bild aus der öffentlichen
// Katalog-Ansicht v_catalog (nur aktive Produkte, anon-lesbar) geholt und in
// die vorhandenen og:-Meta-Tags von index.html geschrieben. Keine Preise.
//
// Sicherheit: nur UUIDs werden abgefragt; feste Supabase-Adresse; Werte
// werden per setAttribute/setInnerContent gesetzt (HTMLRewriter maskiert
// selbst). Fehler/Timeout → unveränderte Seite.

const UUID = /^\/produkt\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const CACHE_SECONDS = 300;
const TIMEOUT_MS = 1500;
const MAX_DESCRIPTION = 200;
const MEMORY_MAX_ENTRIES = 200;

// Die Cache-API ist auf *.workers.dev ein No-op — daher zusätzlich ein
// kleiner Zwischenspeicher pro Worker-Instanz (geht bei Neustart verloren).
const memory = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const page = await env.ASSETS.fetch(request);

    const match = UUID.exec(url.pathname);
    if (!match || request.method !== 'GET' || !isHtml(page)) return page;

    let product = null;
    try {
      product = await loadProduct(match[1].toLowerCase(), env, ctx);
    } catch {
      product = null;
    }
    if (!product) return page;

    const title = `${product.name} – Mein 3D-Druck`;
    const description = shorten(product.description) || 'Jetzt ansehen bei Mein 3D-Druck';
    const image = absoluteUrl(product.image, url);
    const setContent = (value) => ({
      element(el) {
        el.setAttribute('content', value);
      },
    });

    let rewriter = new HTMLRewriter()
      .on('title', { element: (el) => el.setInnerContent(title) })
      .on('meta[name="description"]', setContent(description))
      .on('meta[property="og:type"]', setContent('product'))
      .on('meta[property="og:title"]', setContent(title))
      .on('meta[property="og:description"]', setContent(description))
      .on('meta[property="og:url"]', setContent(`${url.origin}/produkt/${match[1].toLowerCase()}`));
    if (image) rewriter = rewriter.on('meta[property="og:image"]', setContent(image));

    return rewriter.transform(page);
  },
};

function isHtml(response) {
  return response.ok && (response.headers.get('content-type') ?? '').includes('text/html');
}

async function loadProduct(id, env, ctx) {
  const hit = memory.get(id);
  if (hit && hit.expires > Date.now()) return hit.product;

  const product = await loadProductUncached(id, env, ctx);
  if (memory.size >= MEMORY_MAX_ENTRIES) memory.delete(memory.keys().next().value);
  memory.set(id, { product, expires: Date.now() + CACHE_SECONDS * 1000 });
  return product;
}

async function loadProductUncached(id, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://og-preview.internal/produkt/${id}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const api = new URL('/rest/v1/v_catalog', env.SUPABASE_URL);
  api.searchParams.set('product_id', `eq.${id}`);
  api.searchParams.set('select', 'name,description,images');
  api.searchParams.set('limit', '1');
  const res = await fetch(api, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  const product =
    row && typeof row.name === 'string'
      ? {
          name: row.name,
          description: typeof row.description === 'string' ? row.description : null,
          image: Array.isArray(row.images) && typeof row.images[0]?.url === 'string' ? row.images[0].url : null,
        }
      : null;

  // Auch "nicht gefunden" kurz cachen, damit zufällige IDs keine Last erzeugen.
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(product), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SECONDS}` },
      }),
    ),
  );
  return product;
}

function shorten(text) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_DESCRIPTION ? `${clean.slice(0, MAX_DESCRIPTION - 1)}…` : clean;
}

function absoluteUrl(value, base) {
  if (!value) return null;
  try {
    const u = new URL(value, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
