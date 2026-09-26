-- Migration 00151: Seed-Daten
-- Siehe specs/implementierungsplan-schritt9.md §6, specs/audit-settings.md §2.
--
-- settings: genau eine Zeile. Idempotent per WHERE NOT EXISTS statt
-- ON CONFLICT DO NOTHING — settings hat außer der generierten id keine
-- Unique-Spalte, die als Conflict-Target für "genau eine Zeile" taugen würde;
-- WHERE NOT EXISTS verhindert eine zweite Zeile unabhängig davon.
insert into settings (
  email_system_enabled,
  email_required_at_order,
  electricity_price_per_kwh,
  default_labor_rate_per_hour,
  customer_data_retention_days,
  min_order_value
)
select
  false,
  false,
  0.37,
  20.00,
  730,
  null
where not exists (select 1 from settings);

-- admins: KEIN Seed-Eintrag. Der Account wird über das Supabase Auth
-- Dashboard inklusive 2FA angelegt (implementierungsplan-schritt9.md §6/§7),
-- nicht per Migrations-SQL.

-- colors / finishes: kein Seed, beide Tabellen starten leer
-- (implementierungsplan-schritt9.md §6).
