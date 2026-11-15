import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { DEFAULT_CURRENCY_CODE, LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { appConfig } from './app.config';

describe('appConfig Locale (Review A1/F4)', () => {
  beforeEach(() => {
    const localeProviders = appConfig.providers.filter(
      (p) => typeof p === 'object' && p !== null && 'provide' in p && (p.provide === LOCALE_ID || p.provide === DEFAULT_CURRENCY_CODE),
    );
    TestBed.configureTestingModule({ providers: [...localeProviders, CurrencyPipe, DecimalPipe] });
  });

  it('formatiert Preise deutsch mit Euro hinten', () => {
    const pipe = TestBed.inject(CurrencyPipe);
    expect(pipe.transform(19.98)?.replace(/ /g, ' ')).toBe('19,98 €');
    expect(pipe.transform(1234.5, 'EUR')?.replace(/ /g, ' ')).toBe('1.234,50 €');
  });

  it('formatiert Zahlen mit Komma', () => {
    expect(TestBed.inject(DecimalPipe).transform(6.49, '1.2-2')).toBe('6,49');
  });
});
