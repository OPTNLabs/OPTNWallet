import { LOCALE_LABELS, SUPPORTED_LOCALES } from '../../i18n/types';
import { useI18n } from '../../i18n/useI18n';
import SectionCard from '../../components/ui/SectionCard';

export function LanguageSettings() {
  const { locale, setLocale, t } = useI18n();

  return (
    <SectionCard className="p-4">
      <label
        className="block text-sm font-semibold wallet-text-strong"
        htmlFor="wallet-language"
      >
        {t('settings.language')}
      </label>
      <p className="mt-1 text-sm wallet-muted">
        {t('settings.languageDescription')}
      </p>
      <select
        id="wallet-language"
        value={locale}
        onChange={(event) => setLocale(event.target.value as typeof locale)}
        className="wallet-input mt-3 w-full rounded-md px-3 py-2 wallet-text-strong"
      >
        {SUPPORTED_LOCALES.map((supportedLocale) => (
          <option key={supportedLocale} value={supportedLocale}>
            {LOCALE_LABELS[supportedLocale]}
          </option>
        ))}
      </select>
    </SectionCard>
  );
}
