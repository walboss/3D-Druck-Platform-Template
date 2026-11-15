import { parseCsv } from './makerworld-import.util';

describe('parseCsv', () => {
  it('liest Spalten in beliebiger Reihenfolge', () => {
    const r = parseCsv('name,link,category,tags\nHund,https://makerworld.com/en/models/1,Tiere,"a, b"');
    expect(r.error).toBeNull();
    expect(r.entries).toEqual([
      { link: 'https://makerworld.com/en/models/1', source: 'csv', category: 'Tiere', name: 'Hund', tags: ['a', 'b'] },
    ]);
  });

  it('meldet fehlende link-Spalte', () => {
    expect(parseCsv('name\nx').error).toContain('link');
  });

  it('meldet leere Datei', () => {
    expect(parseCsv('  \n').error).toBe('CSV-Datei ist leer.');
  });

  it('überspringt Zeilen ohne Link und versteht Anführungszeichen', () => {
    const r = parseCsv('link,name\n,leer\nhttps://x/models/2,"A ""B"", C"');
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].name).toBe('A "B", C');
  });
});
