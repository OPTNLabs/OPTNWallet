import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { FaArrowDown, FaArrowUp, FaBitcoin } from 'react-icons/fa';
import { AppDispatch, RootState } from '../redux/store';
import { setFetchingUTXOs, replaceAllUTXOs, setInitialized } from '../redux/utxoSlice';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import SectionHeader from '../components/ui/SectionHeader';
import ActionTile from '../components/ui/ActionTile';
import WalletScreen from '../components/ui/WalletScreen';
import PriceFeed from '../components/PriceFeed';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import ElectrumService, { primeUTXOCache } from '../services/ElectrumService';
import UTXOService from '../services/UTXOService';
import { runWalletUtxoRefresh } from '../services/RefreshCoordinator';
import { refreshUTXOWorkerSubscriptions } from '../workers/UTXOWorkerService';
import { logError } from '../utils/errorHandling';
import { UTXO } from '../types/types';
import { Network } from '../redux/networkSlice';
import { SATSINBITCOIN } from '../utils/constants';

const Home: React.FC = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const dbService = useMemo(() => DatabaseService(), []);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const reduxUTXOs = useSelector((state: RootState) => state.utxos.utxos);
  const fetchingUTXOsRedux = useSelector(
    (state: RootState) => state.utxos.fetchingUTXOs
  );
  const totalBalance = useSelector((state: RootState) => state.utxos.totalBalance);
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );
  const bchUsdQuote = useSelector((state: RootState) => state.priceFeed['BCH-USD']?.price);
  const [displayMode, setDisplayMode] = useState<'BCH' | 'USD'>('BCH');
  const totalBch = totalBalance / SATSINBITCOIN;
  const totalUsd = typeof bchUsdQuote === 'number' ? totalBch * bchUsdQuote : null;

  const handleRefresh = useCallback(async () => {
    if (fetchingUTXOsRedux || !currentWalletId) return;

    const allUTXOs: Record<string, UTXO[]> = {};
    dispatch(setFetchingUTXOs(true));

    try {
      await runWalletUtxoRefresh(currentWalletId, async () => {
        await ElectrumService.reconnect();
        const addresses = Object.keys(reduxUTXOs);
        const fetched = await UTXOService.fetchAndStoreUTXOsMany(currentWalletId, addresses);
        for (const [address, list] of Object.entries(fetched)) {
          allUTXOs[address] = list;
          primeUTXOCache(address, list);
        }
        dispatch(replaceAllUTXOs({ utxosByAddress: allUTXOs }));
        dbService.scheduleDatabaseSave();
        dispatch(setInitialized(true));
        await refreshUTXOWorkerSubscriptions();
      });
    } catch (error) {
      logError('Home.handleRefresh', error, { walletId: currentWalletId });
    } finally {
      dispatch(setFetchingUTXOs(false));
    }
  }, [
    currentWalletId,
    dbService,
    dispatch,
    fetchingUTXOsRedux,
    reduxUTXOs,
  ]);

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader
          title="Home"
          subtitle={currentNetwork === Network.CHIPNET ? 'Chipnet' : undefined}
          compact
        />

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-4">
          <SectionCard className="shrink-0 p-3">
            <PriceFeed compact />
          </SectionCard>

          <SectionCard className="shrink-0 p-3">
            <SectionHeader
              title="Portfolio"
              subtitle="Wallet overview"
              compact
              action={
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="wallet-btn-secondary px-3 py-1.5 text-sm"
                  disabled={fetchingUTXOsRedux}
                >
                  {fetchingUTXOsRedux ? 'Syncing…' : 'Sync'}
                </button>
              }
            />
            <div className="flex items-center justify-between gap-3">
              <div>
                <button
                  type="button"
                  onClick={() => setDisplayMode((mode) => (mode === 'BCH' ? 'USD' : 'BCH'))}
                  className="text-left"
                >
                  <div className="text-2xl font-bold wallet-text-strong">
                    {displayMode === 'BCH'
                      ? `${totalBch.toFixed(8)} BCH`
                      : totalUsd !== null
                        ? `$${totalUsd.toFixed(2)} USD`
                        : 'USD unavailable'}
                  </div>
                  <div className="text-xs wallet-muted">
                    {displayMode === 'BCH'
                      ? totalUsd !== null
                        ? `$${totalUsd.toFixed(2)} USD`
                        : 'USD price unavailable'
                      : `${totalBch.toFixed(8)} BCH`}
                  </div>
                </button>
              </div>
              <button
                type="button"
                onClick={() => setDisplayMode((mode) => (mode === 'BCH' ? 'USD' : 'BCH'))}
                className="flex h-14 w-14 items-center justify-center rounded-3xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)] transition hover:brightness-[1.04]"
                aria-label="Toggle BCH and USD balance"
              >
                <FaBitcoin className="text-2xl" />
              </button>
            </div>
          </SectionCard>

          <SectionCard className="shrink-0 p-3">
            <SectionHeader title="Quick Actions" compact />
            <div className="grid grid-cols-2 gap-2.5">
              <ActionTile
                title="Receive"
                icon={<FaArrowDown />}
                compact
                layout="horizontal"
                onClick={() => navigate('/receive')}
              />
              <ActionTile
                title="Send"
                icon={<FaArrowUp />}
                compact
                layout="horizontal"
                onClick={() => navigate('/send')}
              />
              <ActionTile
                title="Assets"
                icon={<FaBitcoin />}
                compact
                layout="horizontal"
                onClick={() => navigate('/assets')}
              />
              <ActionTile
                title="Apps"
                icon={<FaArrowUp />}
                compact
                layout="horizontal"
                onClick={() => navigate('/apps')}
              />
            </div>
          </SectionCard>
        </div>
      </div>
    </WalletScreen>
  );
};

export default Home;
