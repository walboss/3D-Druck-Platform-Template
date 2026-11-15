import { TestBed } from '@angular/core/testing';

import { MakerworldPlate, PlateMappingState, defaultMappingState } from '../../core/utils/makerworld-plates.util';
import { MakerworldPlateMapping } from './makerworld-plate-mapping';

// Elch-Fall: eine Platte, 35 g Weiß + 2 g Schwarz
const plates: MakerworldPlate[] = [
  {
    plateNo: 1,
    printMinutes: 147,
    weightG: 37,
    imageUrl: null,
    filaments: [
      { slot: '1', type: 'PLA', color: '#FFFFFF', usedG: 35 },
      { slot: '2', type: 'PLA', color: '#000000', usedG: 2 },
    ],
  },
];

async function setup(state: PlateMappingState) {
  await TestBed.configureTestingModule({ imports: [MakerworldPlateMapping] }).compileComponents();
  const fixture = TestBed.createComponent(MakerworldPlateMapping);
  fixture.componentRef.setInput('plates', plates);
  fixture.componentRef.setInput('state', state);
  fixture.componentRef.setInput('viewerUrl', 'https://makerworld.com/de/models/1#profileId-9');
  await fixture.whenStable();
  return fixture;
}

describe('MakerworldPlateMapping', () => {
  it('entfernt eine Farbe, rechnet sie der Grundfarbe zu und stellt sie wieder her', async () => {
    const fixture = await setup(defaultMappingState(plates, 'Elch'));
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.viewer-link')?.getAttribute('href')).toBe('https://makerworld.com/de/models/1#profileId-9');

    const removeButtons = el.querySelectorAll<HTMLButtonElement>('button[aria-label="Farbe entfernen"]');
    expect(removeButtons.length).toBe(2);
    removeButtons[1].click();
    await fixture.whenStable();

    expect(fixture.componentInstance.state().removedAreas).toEqual(['1:2']);
    expect(el.querySelector('.area-added')?.textContent).toContain('+2 g');
    // Letzte Farbe der Platte lässt sich nicht entfernen
    expect(el.querySelectorAll('button[aria-label="Farbe entfernen"]').length).toBe(0);

    el.querySelector<HTMLButtonElement>('button[aria-label="Farbe wiederherstellen"]')!.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.state().removedAreas).toEqual([]);
  });
});
