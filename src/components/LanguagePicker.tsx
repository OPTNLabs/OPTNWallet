import { LOCALE_LABELS, SUPPORTED_LOCALES } from '../i18n/types';
import { useI18n } from '../i18n/useI18n';

export default function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();

  return (
    <label className="flex items-center gap-2 text-sm wallet-text-strong">
      <span className="sr-only">{t('app.language')}</span>
      <select
        aria-label={t('app.language')}
        value={locale}
        onChange={(event) => setLocale(event.target.value as typeof locale)}
        className="wallet-input rounded-full px-2 py-1.5 text-sm"
      >
        {SUPPORTED_LOCALES.map((supportedLocale) => (
          <option key={supportedLocale} value={supportedLocale}>
            {LOCALE_LABELS[supportedLocale]}
          </option>
        ))}
      </select>
    </label>
  );
}
