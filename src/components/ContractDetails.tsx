import { useI18n } from '../i18n/useI18n';

type ContractDetailsProps = {
  /** When true, omit outer padding/scroll (parent About panel owns layout). */
  embedded?: boolean;
};

const ContractDetails = ({ embedded = false }: ContractDetailsProps) => {
  const { t } = useI18n();
  const contracts = [
    {
      title: 'contract.bip38',
      desc: 'contract.bip38Desc',
      href: 'https://github.com/OPTNLabs/OPTNWallet/blob/main/src/apis/ContractManager/artifacts/bip38.json',
      bullets: [
        'contract.passwordProtection',
        'contract.bip38Spending',
        'contract.bip38UseCase',
      ],
    },
    {
      title: 'contract.escrow',
      desc: 'contract.escrowDesc',
      href: 'https://cashscript.org/docs/guides/covenants#restricting-p2pkh-recipients',
      bullets: [
        'contract.arbiter',
        'contract.escrowSpending',
        'contract.escrowSecurity',
      ],
    },
    {
      title: 'contract.escrowMS2',
      desc: 'contract.escrowMS2Desc',
      href: 'https://github.com/OPTNLabs/OPTNWallet/blob/main/src/apis/ContractManager/artifacts/escrowMS2.json',
      bullets: [
        'contract.multipleArbiters',
        'contract.escrowMS2Spending',
        'contract.enhancedTrust',
      ],
    },
    {
      title: 'contract.msvault',
      desc: 'contract.msvaultDesc',
      href: 'https://github.com/OPTNLabs/OPTNWallet/blob/main/src/apis/ContractManager/artifacts/msvault.json',
      bullets: [
        'contract.multiSignature',
        'contract.msvaultSpending',
        'contract.msvaultUseCase',
      ],
    },
    {
      title: 'contract.p2pkh',
      desc: 'contract.p2pkhDesc',
      href: 'https://github.com/CashScript/cashscript/blob/master/examples/p2pkh.cash',
      bullets: [
        'contract.simplicity',
        'contract.p2pkhSpending',
        'contract.p2pkhSecurity',
      ],
    },
    {
      title: 'contract.transfer',
      desc: 'contract.transferDesc',
      href: 'https://github.com/CashScript/cashscript/blob/master/examples/transfer_with_timeout.cash',
      bullets: [
        'contract.timeControl',
        'contract.transferSpending',
        'contract.transferUseCase',
      ],
    },
  ] as const;

  const body = (
    <>
      <p className="mb-4">{t('contract.intro')}</p>
      <h3 className="text-2xl font-bold mb-2">{t('contract.available')}</h3>
      <div className="mb-4">
        {contracts.map((contract) => (
          <div key={contract.title} className="mb-6">
            <h4 className="text-xl font-semibold">
              <a
                href={contract.href}
                className="wallet-link hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t(contract.title)}
              </a>
            </h4>
            <p className="mb-2">{t(contract.desc)}</p>
            <ul className="list-disc list-inside mb-2">
              {contract.bullets.map((bullet) => (
                <li key={bullet}>{t(bullet)}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <h3 className="text-2xl font-bold mb-2">{t('contract.howToUse')}</h3>
      <p className="mb-4">{t('contract.howToUseText')}</p>
    </>
  );

  if (embedded) {
    return <div className="w-full">{body}</div>;
  }

  return (
    <div className="flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-2xl overflow-y-auto max-h-[65vh]">
        {body}
      </div>
    </div>
  );
};

export default ContractDetails;
