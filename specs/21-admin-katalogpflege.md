# Admin: Katalogpflege

**Datenquelle:** products, product_variants, colors, finishes,
fn_create_calculation_version, fn_round_up_to_49_99

**Elemente:**
- Produktliste mit Aktiv/Inaktiv-Toggle (steuert v_catalog-Sichtbarkeit)
- Produkt-Editor: Stammdaten, Bilder (extern_link/eigenes_hosting), Tags
- Varianten-Editor: erlaubte Farben/Finishes/Größen je Produkt
- Kalkulationsversionen: neue Version anlegen (kopiert Kostenwerte),
  "aktuell gültig"-Umschaltung nur für Scope product_variant, Endpreis
  automatisch auf .49/.99 aufgerundet (nie ab)

**Best Practice:** Preisänderung erzeugt immer eine NEUE Kalkulationsversion
statt bestehende zu überschreiben — Historie bleibt nachvollziehbar
