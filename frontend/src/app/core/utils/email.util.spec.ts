import { isEmailFormatValid } from './email.util';

describe('isEmailFormatValid', () => {
  it('akzeptiert normale Adressen und leeres Feld', () => {
    expect(isEmailFormatValid('max@example.de')).toBe(true);
    expect(isEmailFormatValid(' anna.b@mail.co.uk ')).toBe(true);
    expect(isEmailFormatValid('')).toBe(true);
  });

  it('lehnt offensichtlich falsche Adressen ab', () => {
    expect(isEmailFormatValid('max@example')).toBe(false);
    expect(isEmailFormatValid('max example@test.de')).toBe(false);
    expect(isEmailFormatValid('maxexample.de')).toBe(false);
    expect(isEmailFormatValid('max@@example.de')).toBe(false);
  });
});
