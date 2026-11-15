import { confirmOrderSummary } from './order-confirm-summary';

describe('confirmOrderSummary', () => {
  it('nennt Status und schlüsselt Positionen auf', () => {
    expect(
      confirmOrderSummary({
        order_status: 'InProduction',
        items: [
          { order_item_id: '1', status: 'Fertig', reserved: true },
          { order_item_id: '2', status: 'InProduktion', reserved: false },
          { order_item_id: '3', status: 'InProduktion', reserved: false },
          { order_item_id: '4', status: 'Storniert', reserved: false },
        ],
      }),
    ).toBe('Status: In Produktion. Positionen: 1× Fertig (aus Lager), 2× In Produktion.');
  });

  it('kommt mit leerer Rückgabe zurecht', () => {
    expect(confirmOrderSummary({ order_status: null, items: [] })).toBe('');
  });
});
