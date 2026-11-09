import { useState } from 'react';
import NetworkContextBanner from '../components/ui/NetworkContextBanner';
import PageHeader from '../components/ui/PageHeader';
import WalletScreen from '../components/ui/WalletScreen';
import TransactionActions from '../features/transaction/components/TransactionActions';
import { Network } from '../state/slices/networkSlice';
import { getUiFixtureBuilderReview, uiFixtureScenario } from './fixtureData';

export default function BuilderReviewFixture() {
  const [notice, setNotice] = useState('');
  const { rawTx, selectedUtxos, txOutputs } =
    getUiFixtureBuilderReview(uiFixtureScenario());

  const displayOnly = () => {
    setNotice('The UI fixture is display-only; no transaction was signed.');
  };

  return (
    <WalletScreen>
      <PageHeader
        title="Custom transaction review"
        subtitle="Fixture · display-only"
      />
      <NetworkContextBanner network={Network.CHIPNET} />
      <div className="wallet-card mt-4 p-3 text-sm">
        <p className="font-semibold">Review the complete transaction</p>
        <p className="mt-1 wallet-muted">
          Confirm the selected funds, recipients, fee, and token accounting
          before the final slide action.
        </p>
      </div>
      <div className="mt-4">
        <TransactionActions
          loading={false}
          buildTransaction={displayOnly}
          sendTransaction={displayOnly}
          rawTX={rawTx}
          txOutputs={txOutputs}
          selectedUtxos={selectedUtxos}
        />
      </div>
      {notice ? (
        <p role="status" className="mt-3 wallet-inline-success rounded-xl p-3">
          {notice}
        </p>
      ) : null}
    </WalletScreen>
  );
}
