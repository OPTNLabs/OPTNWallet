import { describe, expect, it } from 'vitest';
import {
  classifyTranslation,
  isStableTermValue,
  placeholderMismatch,
  placeholders,
} from '../translationPolicy';

describe('translation policy', () => {
  it('extracts and compares interpolation variables independent of order', () => {
    expect(placeholders('Move {count} items to {address}')).toEqual([
      'address',
      'count',
    ]);
    expect(
      placeholderMismatch(
        'Move {count} items to {address}',
        'Mover {address} itens: {count}'
      )
    ).toBe(false);
    expect(placeholderMismatch('Retry {message}', 'Retry')).toBe(true);
  });

  it('classifies stable, translated, and fallback values', () => {
    expect(
      classifyTranslation(
        'actions.walletConnect',
        'WalletConnect',
        'WalletConnect',
        'fr'
      )
    ).toBe('stable-term');
    expect(
      classifyTranslation('app.language', 'Language', 'Langue', 'fr')
    ).toBe('translated');
    expect(
      classifyTranslation('app.language', 'Language', 'Language', 'fr')
    ).toBe('needs-review');
  });

  it('treats Cash Code, not the legacy Paycode label, as the stable UI term', () => {
    expect(isStableTermValue('Cash Code')).toBe(true);
    expect(isStableTermValue('Paycode')).toBe(false);
  });

  it('keeps add-on and internal boundaries explicit', () => {
    expect(
      classifyTranslation('apps.external.name', 'Example', 'Example', 'fr')
    ).toBe('external-value');
    expect(classifyTranslation('internal.debug', 'Debug', 'Debug', 'fr')).toBe(
      'internal-only'
    );
  });
});
