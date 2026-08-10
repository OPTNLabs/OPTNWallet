import { useEffect, useMemo, type PropsWithChildren } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { selectLocale, setLocale } from '../state/slices/preferencesSlice';
import type { AppDispatch, RootState } from '../state/store';
import { detectSupportedLocale, localeDirection } from './types';
import { I18nContext, type I18nContextValue } from './I18nContext';
import type { TranslationKey } from './resources';
import type { SupportedLocale } from './types';
import { translate } from './translate';

export function I18nProvider({ children }: PropsWithChildren) {
  const dispatch = useDispatch<AppDispatch>();
  const persistedLocale = useSelector((state: RootState) =>
    selectLocale(state)
  );
  const locale = detectSupportedLocale(persistedLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDirection(locale);
  }, [locale]);

  const value = useMemo(
    (): I18nContextValue => ({
      locale,
      setLocale: (nextLocale: SupportedLocale) =>
        dispatch(setLocale(nextLocale)),
      t: (key: TranslationKey, values?: Record<string, string | number>) =>
        translate(locale, key, values),
    }),
    [dispatch, locale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
