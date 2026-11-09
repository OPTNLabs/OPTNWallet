import { useI18n } from '../../i18n/useI18n';
import MaskedValue from '../ui/MaskedValue';

const CASH_ADDRESS_PATTERN = /\b(?:bitcoincash|bchtest):[a-z0-9]+/gi;

type MaskedConnectorDescriptionProps = {
  value: string;
};

export default function MaskedConnectorDescription({
  value,
}: MaskedConnectorDescriptionProps) {
  const { t } = useI18n();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(CASH_ADDRESS_PATTERN)) {
    const address = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) parts.push(value.slice(lastIndex, start));
    parts.push(
      <MaskedValue
        key={`${address}-${start}`}
        value={address}
        label={t('wc.address')}
        ariaLabel={t('wc.address')}
        prefixLength={5}
        suffixLength={5}
        preserveCashAddressPrefix
        maskLength={8}
        revealOnClick
        embedded
      />
    );
    lastIndex = start + address.length;
  }

  if (lastIndex === 0) return <>{value}</>;
  if (lastIndex < value.length) parts.push(value.slice(lastIndex));
  return <>{parts}</>;
}
