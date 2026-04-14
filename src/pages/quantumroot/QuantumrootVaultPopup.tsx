import React from 'react';
import { useNavigate } from 'react-router-dom';

import Popup from '../../components/transaction/Popup';
import { shortenTxHash } from '../../utils/shortenHash';
import { SATSINBITCOIN } from '../../utils/constants';
import type { QuantumrootTokenAwareness } from '../../services/QuantumrootTokenAwarenessService';
import type { QuantumrootVaultRecord, UTXO } from '../../types/types';
import type { VaultStatusView } from './quantumrootTypes';
import SelectableValueCard from './SelectableValueCard';

type QuantumrootVaultPopupProps = {
  selectedVault: QuantumrootVaultRecord | null;
  selectedVaultStatus: VaultStatusView | null;
  selectedVaultTokenAwareness: QuantumrootTokenAwareness | null;
  recoveryDestinationAddress: string | null;
  pendingSpendAddress: string;
  pendingTokenCategory: string;
  recoveringOutpoint: string | null;
  sweepingAll: boolean;
  savingConfiguration: boolean;
  isPreviewOnly: boolean;
  isActiveNetwork: boolean;
  bchSpendEnabled: boolean;
  activationLabel: string | null;
  onClose: () => void;
  onCopy: (value: string) => void;
  onSpendAddressChange: (value: string) => void;
  onTokenCategoryChange: (value: string) => void;
  onUseRecoveryDestination: () => void;
  onSweepAll: () => void;
  onSaveConfiguration: () => void;
  onSpendUtxo: (utxo: UTXO, destinationAddress: string) => void;
  onRecoverQuantumLockUtxo: (utxo: UTXO, destinationAddress: string) => void;
};

function formatBch(sats: number) {
  return `${(sats / SATSINBITCOIN).toFixed(8).replace(/\.?0+$/, '') || '0'} BCH`;
}

const QuantumrootVaultPopup: React.FC<QuantumrootVaultPopupProps> = ({
  selectedVault,
  selectedVaultStatus,
  selectedVaultTokenAwareness,
  recoveryDestinationAddress,
  pendingSpendAddress,
  pendingTokenCategory,
  recoveringOutpoint,
  sweepingAll,
  savingConfiguration,
  isPreviewOnly,
  isActiveNetwork,
  bchSpendEnabled,
  activationLabel,
  onClose,
  onCopy,
  onSpendAddressChange,
  onTokenCategoryChange,
  onUseRecoveryDestination,
  onSweepAll,
  onSaveConfiguration,
  onSpendUtxo,
  onRecoverQuantumLockUtxo,
}) => {
  const navigate = useNavigate();

  if (!selectedVault) return null;

  return (
    <Popup closePopups={onClose} closeButtonText="Close">
      <h3 className="text-xl font-bold mb-4 text-center">
        Quantumroot Vault #{selectedVault.address_index}
      </h3>
      <div className="space-y-3">
        <SelectableValueCard
          label="Receive Address"
          value={selectedVault.receive_address}
          qrValue={selectedVault.receive_address}
          onCopy={onCopy}
          copyLabel="Copy Receive Address"
          helperText={isPreviewOnly ? 'Preview only on mainnet until activation.' : undefined}
        />
        <SelectableValueCard
          label="Quantum Lock"
          value={selectedVault.quantum_lock_address}
          onCopy={onCopy}
          copyLabel="Copy Quantum Lock"
        />
        <div className="grid grid-cols-2 gap-3">
          <div className="wallet-surface-strong rounded-[14px] p-3">
            <div className="text-[11px] font-semibold wallet-muted mb-1">
              Receive BCH
            </div>
            <div className="font-bold">
              {formatBch(selectedVaultStatus?.receiveBalanceSats ?? 0)}
            </div>
          </div>
          <div className="wallet-surface-strong rounded-[14px] p-3">
            <div className="text-[11px] font-semibold wallet-muted mb-1">
              Quantum Lock BCH
            </div>
            <div className="font-bold">
              {formatBch(selectedVaultStatus?.quantumLockBalanceSats ?? 0)}
            </div>
          </div>
        </div>
        <div className="wallet-surface-strong rounded-[14px] p-3">
          <div className="text-[11px] font-semibold wallet-muted mb-1">
            Wallet Recovery Address
          </div>
          <div className="text-sm break-all">
            {recoveryDestinationAddress ?? 'No standard wallet address available'}
          </div>
          <div className="text-[11px] wallet-muted mt-1">
            BCH recovery sends back to the matching standard wallet address for this
            vault index when available.
          </div>
        </div>
        <div className="wallet-surface-strong rounded-[14px] p-3 text-sm">
          <div className="font-semibold mb-2">Spend BCH</div>
          <div className="space-y-3">
            <div>
              <div className="text-[11px] font-semibold wallet-muted mb-1">
                Destination Address
              </div>
              <input
                value={pendingSpendAddress}
                onChange={(e) => onSpendAddressChange(e.target.value)}
                placeholder="bitcoincash:... or bchtest:..."
                className="w-full px-3 py-2 rounded-[14px] wallet-surface-strong border border-[var(--wallet-border)] outline-none text-sm"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <button
              className="wallet-btn-secondary w-full"
              disabled={!recoveryDestinationAddress}
              onClick={onUseRecoveryDestination}
            >
              Use Wallet Recovery Address
            </button>
            <button
              className="wallet-btn-primary w-full"
              disabled={
                !bchSpendEnabled ||
                sweepingAll ||
                !pendingSpendAddress.trim() ||
                !isActiveNetwork ||
                !selectedVaultStatus?.recoverableReceiveUtxos.length
              }
              onClick={onSweepAll}
            >
              {sweepingAll
                ? 'Sweeping…'
                : `Sweep All Receive UTXOs (${selectedVaultStatus?.recoverableReceiveUtxos.length ?? 0})`}
            </button>
            <div className="text-[11px] wallet-muted">
              {bchSpendEnabled
                ? 'The current minimum Quantumroot spend path supports BCH-only receive UTXOs. `Sweep All` now aggregates all selected receive UTXOs into one verified transaction to the same destination.'
                : 'Quantumroot BCH spend is temporarily disabled while the on-chain receive-script validation mismatch is being resolved. Receive tracking remains safe to use.'}
            </div>
          </div>
        </div>
        <div className="wallet-surface-strong rounded-[14px] p-3 text-sm">
          <div className="font-semibold mb-2">Token Authorization</div>
          <div className="space-y-3">
            <div>
              <div className="text-[11px] font-semibold wallet-muted mb-1">
                Control Token Category
              </div>
              <input
                value={pendingTokenCategory}
                onChange={(e) => onTokenCategoryChange(e.target.value)}
                placeholder="64 hex chars"
                className="w-full px-3 py-2 rounded-[14px] wallet-surface-strong border border-[var(--wallet-border)] outline-none text-sm"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <div className="text-[11px] wallet-muted space-y-1">
              <p>
                Status: {selectedVaultTokenAwareness?.readinessLabel ?? 'Unknown'}
              </p>
              <p>
                Matching control tokens in Quantum Lock:{' '}
                {selectedVaultTokenAwareness?.matchingControlTokenUtxos.length ?? 0}
              </p>
              <p>
                Other Quantum Lock token UTXOs:{' '}
                {selectedVaultTokenAwareness?.unrelatedQuantumLockTokenUtxos.length ?? 0}
              </p>
              <p>
                Tokenized receive UTXOs:{' '}
                {selectedVaultTokenAwareness?.tokenizedReceiveUtxos.length ?? 0}
              </p>
            </div>
            <button
              className="wallet-btn-primary w-full"
              onClick={onSaveConfiguration}
              disabled={savingConfiguration}
            >
              {savingConfiguration ? 'Saving…' : 'Save Token Category'}
            </button>
            <div className="text-[11px] wallet-muted">
              Reconfiguring the token category re-derives this vault. The Quantumroot
              receive and Quantum Lock addresses may change when moving away from the
              provisional placeholder category.
            </div>
            <div className="text-[11px] wallet-muted">
              Authorized spend is still pending while the token-spend leaf
              compiler mismatch is being resolved. BCH receive sweeps and Quantum
              Lock BCH recovery are live today.
            </div>
          </div>
        </div>
        {selectedVaultStatus?.recoverableReceiveUtxos.length ? (
          <div className="wallet-surface-strong rounded-[14px] p-3 text-sm">
            <div className="font-semibold mb-2">Spendable Receive UTXOs</div>
            <div className="space-y-2">
              {selectedVaultStatus.recoverableReceiveUtxos.map((utxo) => {
                const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                const isRecovering = recoveringOutpoint === outpointKey;
                return (
                  <div
                    key={outpointKey}
                    className="rounded-[14px] p-3 border border-[var(--wallet-border)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-bold">
                          {formatBch(utxo.value ?? utxo.amount ?? 0)}
                        </div>
                        <div className="text-[11px] wallet-muted mt-1">
                          {shortenTxHash(utxo.tx_hash)}:{utxo.tx_pos}
                        </div>
                      </div>
                      <button
                        className="wallet-btn-primary px-3 py-2 text-xs"
                        disabled={
                          !bchSpendEnabled ||
                          isRecovering ||
                          !pendingSpendAddress.trim() ||
                          !isActiveNetwork
                        }
                        onClick={() => onSpendUtxo(utxo, pendingSpendAddress)}
                      >
                        {isRecovering ? 'Spending…' : 'Spend'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        {selectedVaultStatus?.unsupportedReceiveUtxos.length ? (
          <div className="text-xs wallet-muted">
            Token-carrying Quantumroot receive UTXOs are detected, but the current
            recovery flow only supports BCH-only receive UTXOs.
          </div>
        ) : null}
        {selectedVaultStatus?.unsupportedQuantumLockUtxos.length ? (
          <div className="text-xs wallet-muted">
            Token-carrying Quantum Lock UTXOs are detected, but the current
            Quantum Lock recovery flow only supports BCH-only Quantum Lock UTXOs.
          </div>
        ) : null}
        {selectedVaultStatus?.recoverableQuantumLockUtxos.length ? (
          <div className="wallet-surface-strong rounded-[14px] p-3 text-sm">
            <div className="font-semibold mb-2">Recoverable Quantum Lock UTXOs</div>
            <div className="space-y-2">
              {selectedVaultStatus.recoverableQuantumLockUtxos.map((utxo) => {
                const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                const isRecovering = recoveringOutpoint === outpointKey;
                return (
                  <div
                    key={outpointKey}
                    className="rounded-[14px] p-3 border border-[var(--wallet-border)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-bold">
                          {formatBch(utxo.value ?? utxo.amount ?? 0)}
                        </div>
                        <div className="text-[11px] wallet-muted mt-1">
                          {shortenTxHash(utxo.tx_hash)}:{utxo.tx_pos}
                        </div>
                      </div>
                      <button
                        className="wallet-btn-primary px-3 py-2 text-xs"
                        disabled={
                          isRecovering ||
                          !pendingSpendAddress.trim() ||
                          !isActiveNetwork
                        }
                        onClick={() =>
                          onRecoverQuantumLockUtxo(utxo, pendingSpendAddress)
                        }
                      >
                        {isRecovering ? 'Recovering…' : 'Recover'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="wallet-surface-strong rounded-[14px] p-3 text-sm">
          <div className="font-semibold mb-2">Actions</div>
          <div className="space-y-2">
            <button
              className="wallet-btn-secondary w-full"
              onClick={() => {
                onClose();
                navigate('/receive');
              }}
            >
              Open Receive Screen
            </button>
            <button
              className="wallet-btn-secondary w-full"
              disabled={!recoveryDestinationAddress}
              onClick={onUseRecoveryDestination}
            >
              Reset Spend Destination
            </button>
            <div className="text-[11px] wallet-muted rounded-[14px] border border-[var(--wallet-border)] px-3 py-2">
              Quantum Lock BCH recovery is now available from the dedicated UTXO
              list above. Token-aware Quantum Lock flows remain pending.
            </div>
            <button className="wallet-btn-secondary w-full" disabled>
              {selectedVaultTokenAwareness?.canAuthorizedSpend
                ? 'Authorized Spend Pending'
                : 'Authorized Spend Waiting For Control Token'}
            </button>
            <button className="wallet-btn-secondary w-full" disabled>
              Token Recovery Soon
            </button>
          </div>
        </div>
        {isPreviewOnly ? (
          <div className="text-xs wallet-muted">
            Mainnet Quantumroot actions remain disabled until activation on {activationLabel}.
          </div>
        ) : null}
        <div className="text-xs wallet-muted space-y-1">
          <p>
            Recoverable BCH receive UTXOs:{' '}
            {selectedVaultStatus?.recoverableReceiveUtxos.length ?? 0}
          </p>
          <p>
            Unsupported token receive UTXOs:{' '}
            {selectedVaultStatus?.unsupportedReceiveUtxos.length ?? 0}
          </p>
          <p>
            Recoverable Quantum Lock UTXOs:{' '}
            {selectedVaultStatus?.recoverableQuantumLockUtxos.length ?? 0}
          </p>
          <p>
            Unsupported token Quantum Lock UTXOs:{' '}
            {selectedVaultStatus?.unsupportedQuantumLockUtxos.length ?? 0}
          </p>
        </div>
      </div>
    </Popup>
  );
};

export default QuantumrootVaultPopup;
