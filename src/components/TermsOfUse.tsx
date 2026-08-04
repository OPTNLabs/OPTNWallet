import { useI18n } from '../i18n/useI18n';

const TermsOfUse = () => {
  const { t } = useI18n();
  return (
    <div className="overflow-y-auto h-full">
      <div className="p-4 rounded-lg space-y-4">
        <h3 className="font-bold">{t('terms.acceptance')}</h3>
        <p>{t('terms.acceptanceText')}</p>

        <h3 className="font-bold">{t('terms.purpose')}</h3>
        <p>{t('terms.purposeText')}</p>

        <h3 className="font-bold">{t('terms.responsibilities')}</h3>
        <p>{t('terms.responsibilitiesIntro')}</p>
        <ul className="list-disc pl-6">
          <li>{t('terms.safeguard')}</li>
          <li>{t('terms.verify')}</li>
          <li>{t('terms.deviceSecurity')}</li>
        </ul>
        <p>{t('terms.responsibilitiesText')}</p>

        <h3 className="font-bold">{t('terms.noLiability')}</h3>
        <p>{t('terms.noLiabilityText')}</p>

        <h3 className="font-bold">{t('terms.noWarranty')}</h3>
        <p>{t('terms.noWarrantyText')}</p>

        <h3 className="font-bold">{t('terms.modifications')}</h3>
        <p>{t('terms.modificationsText')}</p>
      </div>
    </div>
  );
};

export default TermsOfUse;
