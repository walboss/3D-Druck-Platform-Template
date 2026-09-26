-- Migration 00160: MakerWorld-Import — products.makerworld_model_id /
-- makerworld_url / makerworld_title, Enum product_suggestion_status,
-- Tabelle product_suggestions.
-- Siehe specs/27-makerworld-import-vorschlaege.md §2 (Entscheidungen:
-- Duplikat-Schutz über makerworld_model_id, Quell-Link, Originaltitel) und
-- §3 (Datenmodell). Funktionen, Grants und RLS-Policies folgen als eigener
-- Task (Spec 27 §8, Task 2) — hier nur Struktur. RLS wird wie bei allen
-- Tabellen sofort aktiviert (ohne Policies = kein Zugriff außer
-- service_role), damit die Tabelle nie ungeschützt ist.

-- ===========================================================================
-- ABSCHNITT A: products — Herkunft aus MakerWorld
-- ===========================================================================
alter table products
  add column if not exists makerworld_model_id text,
  add column if not exists makerworld_url      text,
  add column if not exists makerworld_title    text;

-- Duplikat-Schutz (Spec 27 §2): eine MakerWorld-Modell-ID höchstens einmal im
-- Katalog. Partial-Unique-Index statt Unique-Constraint, damit manuell
-- angelegte Produkte ohne MakerWorld-Bezug (NULL) beliebig oft vorkommen.
create unique index if not exists uq_products_makerworld_model_id
  on products (makerworld_model_id)
  where makerworld_model_id is not null;

comment on column products.makerworld_model_id is
  'Numerische MakerWorld-Modell-ID (z. B. 1725279), gesetzt beim Import; NULL bei manuell angelegten Produkten. Eindeutig, wenn gesetzt (Duplikat-Schutz).';
comment on column products.makerworld_url is
  'Original-MakerWorld-Link, wie beim Import eingegeben; nur Anzeige im Editor.';
comment on column products.makerworld_title is
  'Englischer Originaltitel von MakerWorld, unverändert; products.name enthält den (übersetzten, ggf. vom Admin editierten) Anzeigenamen.';

-- ===========================================================================
-- ABSCHNITT B: Enum product_suggestion_status
-- ===========================================================================
-- Spec 27 §3: neu → importiert | abgelehnt. Nie löschen, nur Status (#2).
create type product_suggestion_status as enum (
  'neu',
  'importiert',
  'abgelehnt'
);

-- ===========================================================================
-- ABSCHNITT C: product_suggestions — Modellvorschläge von Kunden ohne Login
-- ===========================================================================
-- Spec 27 §1/§3: Kunde reicht nur einen MakerWorld-Link (+ optionale Notiz)
-- ein. Keine Kundendaten (kein Name, keine E-Mail) — nichts zu
-- anonymisieren. Ohne Admin entsteht daraus kein Produkt.
create table product_suggestions (
  id                  uuid primary key default gen_random_uuid(),
  makerworld_url      text not null,
  makerworld_model_id text not null,
  note                text,
  status              product_suggestion_status not null default 'neu',
  product_id          uuid references products(id),
  created_at          timestamptz not null default now(),
  decided_at          timestamptz,
  decided_by          uuid references admins(id),
  constraint chk_product_suggestions_note_len
    check (note is null or char_length(note) <= 500),
  -- importiert ⇒ product_id gesetzt; neu ⇒ keine Entscheidung eingetragen.
  constraint chk_product_suggestions_status_consistency
    check (
      (status = 'neu'        and product_id is null and decided_at is null and decided_by is null) or
      (status = 'importiert' and product_id is not null and decided_at is not null) or
      (status = 'abgelehnt'  and product_id is null and decided_at is not null)
    )
);

-- Spec 27 §3: höchstens ein OFFENER Vorschlag je Modell-ID. Zweite
-- Einreichung derselben ID wird von fn_submit_product_suggestion (Task 2)
-- still ignoriert; der Index sichert die Regel zusätzlich auf DB-Ebene.
create unique index uq_product_suggestions_open_model_id
  on product_suggestions (makerworld_model_id)
  where status = 'neu';

create index idx_product_suggestions_status_created
  on product_suggestions (status, created_at desc);

comment on table product_suggestions is
  'MakerWorld-Modellvorschläge von Kunden ohne Login (Spec 27). Nur Link + optionale Notiz, keine Kundendaten. Admin importiert oder lehnt ab; nie löschen.';
comment on column product_suggestions.makerworld_model_id is
  'Aus dem Link extrahierte numerische Modell-ID; Basis für Duplikat-Prüfung gegen products.makerworld_model_id und offene Vorschläge.';
comment on column product_suggestions.note is
  'Optionale Kundennotiz, max. 500 Zeichen.';
comment on column product_suggestions.product_id is
  'Beim Import angelegtes Produkt (nur bei status = importiert).';

alter table product_suggestions enable row level security;
