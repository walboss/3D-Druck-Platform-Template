# Admin: Lager/Filament

**Datenquelle:** Filamentbestand-/Bewegungstabellen, fn_book_b_ware

**Elemente:**
- Bestandsübersicht je Spule/Material, Schwellenwert-Markierung (kritisch = rot)
- Bewegungshistorie (Wareneingang, Verbrauch, B-Ware-Buchung)
- Manuelle Wareneingangserfassung (löst ggf. Retry-Trigger für wartende
  Reservierungen aus, FIFO)

**Best Practice:** Wareneingang als eigener, einfacher Screen statt Teil der
allgemeinen Bestandsliste — häufigste manuelle Admin-Aktion, minimale Klicks
