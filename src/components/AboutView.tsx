import { useI18n } from '../i18n/useI18n';

const AboutView = () => {
  const { t } = useI18n();
  const features = [
    ['about.creating', 'about.creatingText'],
    ['about.viewing', 'about.viewingText'],
    ['about.building', 'about.buildingText'],
    ['about.security', 'about.securityText'],
  ] as const;
  const reasons = [
    ['about.unmatched', 'about.unmatchedText'],
    ['about.flexibility', 'about.flexibilityText'],
    ['about.intuitive', 'about.intuitiveText'],
    ['about.community', 'about.communityText'],
  ] as const;

  return (
    <div className="flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-2xl overflow-y-auto max-h-[65vh]">
        <h2 className="text-3xl font-bold mb-4">{t('about.overview')}</h2>
        <p className="mb-4">{t('about.overviewText')}</p>

        <h3 className="text-2xl font-bold mb-2">{t('about.keyFeatures')}</h3>
        <ul className="list-disc list-inside mb-4">
          {features.map(([title, description]) => (
            <li key={title} className="mb-2">
              <strong>{t(title)}:</strong> {t(description)}
            </li>
          ))}
        </ul>

        <h3 className="text-2xl font-bold mb-2">{t('about.why')}</h3>
        <ul className="list-disc list-inside mb-4">
          {reasons.map(([title, description]) => (
            <li key={title} className="mb-2">
              <strong>{t(title)}:</strong> {t(description)}
            </li>
          ))}
        </ul>

        <h3 className="text-2xl font-bold mb-2">{t('about.intended')}</h3>
        <p className="mb-4">{t('about.intendedText')}</p>

        <h3 className="text-2xl font-bold mb-2">{t('about.learn')}</h3>
        <p className="mb-4">{t('about.learnText')}</p>
        <ul className="list-disc list-inside mb-4">
          <li className="mb-2">
            <a
              href="https://covenants.info/"
              className="wallet-link hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('about.wiki')}
            </a>
          </li>
          <li className="mb-2">
            <a
              href="https://next.cashscript.org/docs/guides/covenants"
              className="wallet-link hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('about.cashscriptGuide')}
            </a>
          </li>
          <li className="mb-2">
            <a
              href="https://github.com/CashScript/cashscript/tree/master/examples"
              className="wallet-link hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('about.cashscriptExamples')}
            </a>
          </li>
          <li className="mb-2">
            <a
              href="https://cointelegraph.com/news/what-are-bitcoin-covenants-and-how-do-they-work"
              className="wallet-link hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('about.cointelegraph')}
            </a>
          </li>
        </ul>

        <h3 className="text-2xl font-bold mb-2">{t('about.feedback')}</h3>
        <p>
          {t('about.feedbackText')}{' '}
          <a
            href="mailto:info@optnlabs.com"
            className="wallet-link hover:underline"
          >
            info@optnlabs.com
          </a>
          .
        </p>
      </div>
    </div>
  );
};

export default AboutView;
