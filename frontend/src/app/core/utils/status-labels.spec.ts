import { statusLabel } from './status-labels';

describe('statusLabel', () => {
  it('übersetzt Bestellstatus', () => {
    expect(statusLabel('New')).toBe('Eingegangen');
    expect(statusLabel('ReadyForPickup')).toBe('Bereit zur Abholung');
  });

  it('übersetzt Positions-, Produktions-, Anfrage- und Angebotsstatus', () => {
    expect(statusLabel('WartetAufMaterial')).toBe('Wartet auf Material');
    expect(statusLabel('InProduktion')).toBe('In Produktion');
    expect(statusLabel('Laeuft')).toBe('Läuft');
    expect(statusLabel('angebot_erstellt')).toBe('Angebot erstellt');
    expect(statusLabel('geprueft')).toBe('Geprüft');
    expect(statusLabel('abgelaufen')).toBe('Abgelaufen');
    expect(statusLabel('rueckerstattung')).toBe('Rückerstattung');
  });

  it('lässt Unbekanntes unverändert und leert null', () => {
    expect(statusLabel('irgendwas')).toBe('irgendwas');
    expect(statusLabel(null)).toBe('');
  });
});
