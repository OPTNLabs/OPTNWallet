import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { FaArrowDown, FaArrowUp, FaPaperPlane, FaPlus, FaQrcode, FaRegCompass } from 'react-icons/fa';
import { RootState } from '../redux/store';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import SectionHeader from '../components/ui/SectionHeader';
import ActionTile from '../components/ui/ActionTile';
import SegmentedSubnav from '../components/ui/SegmentedSubnav';
import SettingsRow from '../components/ui/SettingsRow';
import EmptyState from '../components/ui/EmptyState';
import WalletScreen from '../components/ui/WalletScreen';
import { shortenTxHash } from '../utils/shortenHash';

type ActionsMode = 'basic' | 'advanced';

const Actions: React.FC = () => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<ActionsMode>('basic');
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const transactions = useSelector(
    (state: RootState) => state.transactions.transactions[currentWalletId]
  );

  const recentTransactions = useMemo(
    () => (transactions ?? []).slice(-2).reverse(),
    [transactions]
  );

  return (
    <WalletScreen maxWidthClassName="max-w-md">
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader title="Actions" subtitle="Simple wallet actions for everyday use" compact />

        <SectionCard className="p-3">
          <SectionHeader
            title="Task mode"
            subtitle="Switch between basic and advanced actions"
            compact
          />
          <SegmentedSubnav
            value={mode}
            onChange={setMode}
            options={[
              { value: 'basic', label: 'Basic' },
              { value: 'advanced', label: 'Advanced' },
            ]}
          />
        </SectionCard>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-4">
          {mode === 'basic' ? (
            <>
              <SectionCard className="p-3">
                <SectionHeader title="Basic Actions" subtitle="Common wallet tasks" compact />
                <div className="grid grid-cols-2 gap-2.5">
                  <ActionTile
                    compact
                    title="Send"
                    icon={<FaPaperPlane />}
                    layout="horizontal"
                    onClick={() => navigate('/send')}
                  />
                  <ActionTile
                    compact
                    title="Receive"
                    icon={<FaArrowDown />}
                    layout="horizontal"
                    onClick={() => navigate('/receive')}
                  />
                  <ActionTile
                    compact
                    title="Scan QR"
                    icon={<FaQrcode />}
                    layout="horizontal"
                    onClick={() => navigate('/paper-wallet-sweep')}
                  />
                  <ActionTile
                    compact
                    title="New Address"
                    icon={<FaPlus />}
                    layout="horizontal"
                    onClick={() => navigate('/receive')}
                  />
                </div>
              </SectionCard>

              <SectionCard className="p-3">
                <SectionHeader
                  title="Recent Activity"
                  compact
                  action={
                    <button
                      className="wallet-link text-sm"
                      onClick={() => navigate(`/transactions/${currentWalletId}`)}
                    >
                      View all
                    </button>
                  }
                />
                <div className="space-y-2.5">
                  {recentTransactions.length > 0 ? (
                    recentTransactions.map((tx) => (
                      <SettingsRow
                        key={tx.tx_hash}
                        title={shortenTxHash(tx.tx_hash)}
                        description={tx.height > 0 ? `Block ${tx.height}` : 'Pending confirmation'}
                        right={<span className="wallet-muted">{tx.height > 0 ? 'Confirmed' : 'Pending'}</span>}
                        compact
                        onClick={() => navigate(`/transactions/${currentWalletId}`)}
                      />
                    ))
                  ) : (
                    <EmptyState message="No recent activity yet." />
                  )}
                </div>
              </SectionCard>
            </>
          ) : (
            <SectionCard className="p-3">
              <SectionHeader
                title="Advanced Actions"
                subtitle="Deeper tools and workflows"
                compact
              />
              <div className="space-y-2.5">
                <ActionTile
                  compact
                  title="Sweep Paper Wallet"
                  description="Import BCH and CashTokens"
                  icon={<FaArrowUp />}
                  layout="horizontal"
                  onClick={() => navigate('/paper-wallet-sweep')}
                />
                <ActionTile
                  compact
                  title="Transaction Builder"
                  description="Open the custom send flow"
                  icon={<FaPaperPlane />}
                  layout="horizontal"
                  onClick={() => navigate('/transaction')}
                />
                <ActionTile
                  compact
                  title="View Apps"
                  description="Explore advanced apps and tools"
                  icon={<FaRegCompass />}
                  layout="horizontal"
                  onClick={() => navigate('/apps')}
                />
                <ActionTile
                  compact
                  title="Contracts"
                  description="Create or manage contract instances"
                  icon={<FaPlus />}
                  layout="horizontal"
                  onClick={() => navigate('/contract')}
                />
              </div>
            </SectionCard>
          )}
        </div>
      </div>
    </WalletScreen>
  );
};

export default Actions;
