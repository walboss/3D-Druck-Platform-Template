import { renumberSlots, slotLabelForSubmit } from './custom-request-form';

describe('renumberSlots', () => {
  it('nummeriert nach Entfernen lückenlos neu (kein doppelter Name)', () => {
    const afterRemove = [
      { label: 'Slot 1', hex: '#111111' },
      { label: 'Slot 3', hex: '#333333' },
    ];
    const added = renumberSlots([...afterRemove, { label: '', hex: '#ff0000' }]);
    expect(added.map((s) => s.label)).toEqual(['Slot 1', 'Slot 2', 'Slot 3']);
    expect(added.map((s) => s.hex)).toEqual(['#111111', '#333333', '#ff0000']);
  });
});

describe('slotLabelForSubmit', () => {
  it('hängt einen Teilenamen an, sonst nur Slot-Nummer', () => {
    expect(slotLabelForSubmit({ label: 'Slot 1', hex: '#000000', name: ' Kopf ' })).toBe('Slot 1 – Kopf');
    expect(slotLabelForSubmit({ label: 'Slot 2', hex: '#000000', name: '  ' })).toBe('Slot 2');
    expect(slotLabelForSubmit({ label: 'Slot 3', hex: '#000000' })).toBe('Slot 3');
  });
});
