import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import {
  FaArrowDown,
  FaBitcoin,
  FaPaperPlane,
  FaPlus,
  FaQrcode,
} from 'react-icons/fa';
import { RootState } from '../../state/store';
import PageHeader from '../../components/ui/PageHeader';
import SectionCard from '../../components/ui/SectionCard';
import SectionHeader from '../../components/ui/SectionHeader';
import ActionTile from '../../components/ui/ActionTile';
import SegmentedSubnav from '../../components/ui/SegmentedSubnav';
import WalletScreen from '../../components/ui/WalletScreen';
import StatusChip from '../../components/ui/StatusChip';
import KeyService from '../../services/KeyService';
import { logError } from '../../utils/errorHandling';
import { ADVANCED_ACTIONS, BASIC_ACTIONS } from './actionsConfig';
import { selectQuantumrootEnabled } from '../../state/slices/experimentalSlice';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/resources';

type ActionsMode = 'basic' | 'advanced';

const ACTION_COPY: Record<
  string,
  {
    title?: TranslationKey;
    description?: TranslationKey;
    badge?: TranslationKey;
  }
> = {
  Send: { title: 'actions.send', description: 'actions.sendDescription' },
  Receive: {
    title: 'actions.receive',
    description: 'actions.receiveDescription',
  },
  'Scan QR': {
    title: 'actions.scanQr',
    description: 'actions.scanQrDescription',
  },
  'New Address': {
    title: 'actions.newAddress',
    description: 'actions.newAddressDescription',
  },
  CashTokens: {
    title: 'actions.cashTokens',
    description: 'actions.cashTokensDescription',
  },
  Quantumroot: {
    title: 'actions.quantumroot',
    description: 'actions.quantumrootDescription',
    badge: 'actions.quantumrootBadge',
  },
  'Transaction Builder': {
    title: 'actions.transactionBuilder',
    description: 'actions.transactionBuilderDescription',
  },
  WalletConnect: {
    title: 'actions.walletConnect',
    description: 'actions.walletConnectDescription',
  },
  WizardConnect: {
    title: 'actions.wizardConnect',
    description: 'actions.wizardConnectDescription',
  },
  CashConnect: {
    description: 'actions.cashConnectDescription',
  },
  Contracts: {
    title: 'actions.contracts',
    description: 'actions.contractsDescription',
  },
  'QR Signing Demo': {
    title: 'qrSigning.title',
    description: 'qrSigning.subtitle',
  },
};

function getBasicActionIcon(title: string) {
  switch (title) {
    case 'Send':
      return <FaPaperPlane />;
    case 'Receive':
      return <FaArrowDown />;
    case 'Scan QR':
      return <FaQrcode />;
    case 'CashTokens':
      return <FaBitcoin />;
    default:
      return <FaPlus />;
  }
}

function getAdvancedActionIcon(title: string) {
  switch (title) {
    case 'Quantumroot':
      return <FaBitcoin />;
    case 'Transaction Builder':
      return <FaPaperPlane />;
    case 'Contracts':
      return <FaPlus />;
    default:
      return <FaQrcode />;
  }
}

const Actions: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [mode, setMode] = useState<ActionsMode>('basic');
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const quantumrootEnabled = useSelector(selectQuantumrootEnabled);
  // Quantumroot is on by default; hide its action when the user disables it in
  // Experimental settings. Additive + backward-compatible (no effect when on).
  const advancedActions = ADVANCED_ACTIONS.filter(
    (a) => quantumrootEnabled || a.to !== '/quantumroot'
  );

  const handleGenerateNewAddress = async () => {
    if (!currentWalletId) return;

    try {
      const keys = await KeyService.retrieveKeys(currentWalletId);
      const nextAddressIndex =
        keys.reduce(
          (max, key) =>
            Number.isFinite(key.addressIndex) && key.addressIndex > max
              ? key.addressIndex
              : max,
          -1
        ) + 1;

      await KeyService.createKeys(currentWalletId, 0, 0, nextAddressIndex);
      await KeyService.createKeys(currentWalletId, 0, 1, nextAddressIndex);
      navigate('/receive?panel=addresses', { state: { returnTo: '/actions' } });
    } catch (error) {
      logError('Actions.handleGenerateNewAddress', error, {
        walletId: currentWalletId,
      });
    }
  };
  return (
    <WalletScreen maxWidthClassName="max-w-md">
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader
          title={t('actions.title')}
          subtitle={t('actions.subtitle')}
          compact
        />

        <SectionCard className="p-3">
          <SectionHeader
            title={t('actions.taskMode')}
            subtitle={t('actions.taskModeDescription')}
            compact
          />
          <SegmentedSubnav
            value={mode}
            onChange={setMode}
            stretch
            options={[
              { value: 'basic', label: t('actions.basic') },
              { value: 'advanced', label: t('actions.advanced') },
            ]}
          />
        </SectionCard>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-4">
          {mode === 'basic' ? (
            <>
              <SectionCard className="p-3">
                <SectionHeader
                  title={t('actions.basicActions')}
                  subtitle={t('actions.commonWalletTasks')}
                  compact
                />
                <div className="space-y-2.5">
                  {BASIC_ACTIONS.map((action) => {
                    const copy = ACTION_COPY[action.title];
                    return (
                      <ActionTile
                        key={action.title}
                        compact
                        title={copy?.title ? t(copy.title) : action.title}
                        icon={getBasicActionIcon(action.title)}
                        layout="horizontal"
                        description={
                          copy?.description
                            ? t(copy.description)
                            : action.description
                        }
                        descriptionLines={2}
                        onClick={() => {
                          if (action.title === 'New Address') {
                            void handleGenerateNewAddress();
                            return;
                          }
                          if (action.title === 'CashTokens') {
                            navigate('/mint-cashtokens-poc', {
                              state: { returnTo: '/actions' },
                            });
                            return;
                          }
                          const returnTo = '/actions';
                          if (
                            action.to === '/send' ||
                            action.to.startsWith('/receive')
                          ) {
                            navigate(action.to, { state: { returnTo } });
                            return;
                          }
                          if (action.to.startsWith('/settings?panel=')) {
                            navigate(action.to, { state: { returnTo } });
                            return;
                          }
                          if (action.to === '/mint-cashtokens-poc') {
                            navigate(action.to, { state: { returnTo } });
                            return;
                          }
                          if (action.to === '/quantumroot') {
                            navigate(action.to, { state: { returnTo } });
                            return;
                          }
                          if (action.to === '/contract') {
                            navigate(action.to, { state: { returnTo } });
                            return;
                          }
                          navigate(action.to, { state: { returnTo } });
                        }}
                      />
                    );
                  })}
                </div>
              </SectionCard>
            </>
          ) : (
            <SectionCard className="p-3 wallet-surface-strong">
              <SectionHeader
                title={t('actions.advancedActions')}
                subtitle={t('actions.deeperTools')}
                compact
              />
              <div className="space-y-2.5">
                {advancedActions.map((action) => {
                  const copy = ACTION_COPY[action.title];
                  return (
                    <ActionTile
                      key={action.title}
                      compact
                      title={copy?.title ? t(copy.title) : action.title}
                      description={
                        copy?.description
                          ? t(copy.description)
                          : action.description
                      }
                      icon={getAdvancedActionIcon(action.title)}
                      layout="horizontal"
                      trailing={
                        action.badge ? (
                          <StatusChip>
                            {copy?.badge ? t(copy.badge) : action.badge}
                          </StatusChip>
                        ) : undefined
                      }
                      onClick={() => {
                        const returnTo = '/actions';
                        if (action.to === '/quantumroot') {
                          navigate(action.to, { state: { returnTo } });
                          return;
                        }
                        if (action.to === '/transaction') {
                          navigate(action.to, { state: { returnTo } });
                          return;
                        }
                        if (action.to === '/contract') {
                          navigate(action.to, { state: { returnTo } });
                          return;
                        }
                        if (action.to.startsWith('/settings?panel=')) {
                          navigate(action.to, { state: { returnTo } });
                          return;
                        }
                        navigate(action.to);
                      }}
                    />
                  );
                })}
              </div>
            </SectionCard>
          )}
        </div>
      </div>
    </WalletScreen>
  );
};

export default Actions;
