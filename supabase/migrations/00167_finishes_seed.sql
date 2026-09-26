-- Migration 00167: Basis-Set an Finishes
-- specs/filament-material.md §2, specs/filament-bibliothek-neuanlage.md
--
-- finishes hatte bislang keinerlei Seed-Daten — ohne mindestens einen
-- Eintrag ist die Filament-Neuanlage blockiert (Finish ist Pflichtfeld,
-- Dropdown aus bestehenden finishes, kein Freitext).

insert into finishes (name)
select v.name
from (values
  ('Matt'),
  ('Glänzend'),
  ('Seidig')
) as v(name)
where not exists (
  select 1 from finishes f where f.name = v.name
);
