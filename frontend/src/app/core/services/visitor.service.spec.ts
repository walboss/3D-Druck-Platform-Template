import { visitorCookieString } from './visitor.service';

describe('visitorCookieString', () => {
  it('setzt Secure auf https', () => {
    expect(visitorCookieString('mw_visitor_id', 'abc', 60, true)).toBe('mw_visitor_id=abc; max-age=60; path=/; SameSite=Lax; Secure');
  });

  it('ohne Secure auf http (lokal)', () => {
    expect(visitorCookieString('mw_visitor_id', 'abc', 60, false)).toBe('mw_visitor_id=abc; max-age=60; path=/; SameSite=Lax');
  });
});
