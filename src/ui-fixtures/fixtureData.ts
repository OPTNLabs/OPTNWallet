import type { OutboundTransactionRecord } from '../services/OutboundTransactionTracker';
import type {
  TransactionHistoryItem,
  TransactionOutput,
  UTXO,
} from '../types/types';
import type { ReviewState } from '../features/simple-send/types';
import type { WalletKitTypes } from '@reown/walletkit';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import type { PendingSignRequest } from '@wizardconnect/wallet';
import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from '@cashconnect-js/nostr';
import type { WalletSession } from '@cashconnect-js/nostr/wallet';
import type { ActiveWizardConnections } from '../redux/wizardconnect/types';

/**
 * Disposable data used only by the local UI fixture harness. These values are
 * public-looking test data; no mnemonic, private key, or signing material is
 * ever included here.
 */
export const UI_FIXTURE_WALLET_ID = 9001;
export const UI_FIXTURE_PRIMARY_ADDRESS =
  'bchtest:qp63uahgrxged4z5jswyt5dn5v3lzsem6cq85x00dt';
export const UI_FIXTURE_CHANGE_ADDRESS =
  'bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvqcw003ap';

const CONFIRMED_TXID = 'a'.repeat(64);
const PENDING_TXID = 'b'.repeat(64);
const OUTBOX_TXID = 'c'.repeat(64);

export function getUiFixtureAddressPairs(): Array<{
  address: string;
  tokenAddress: string;
}> {
  return [
    {
      address: UI_FIXTURE_PRIMARY_ADDRESS,
      tokenAddress: UI_FIXTURE_PRIMARY_ADDRESS,
    },
    {
      address: UI_FIXTURE_CHANGE_ADDRESS,
      tokenAddress: UI_FIXTURE_CHANGE_ADDRESS,
    },
  ];
}

export function getUiFixtureKeyPairs() {
  const publicKey = Uint8Array.from([
    2,
    ...Array.from({ length: 32 }, () => 7),
  ]);
  const pubkeyHash = Uint8Array.from(
    Array.from({ length: 20 }, (_, index) => index + 1)
  );

  return [
    {
      address: UI_FIXTURE_PRIMARY_ADDRESS,
      tokenAddress: UI_FIXTURE_PRIMARY_ADDRESS,
      publicKey,
      pubkeyHash,
      changeIndex: 0,
      addressIndex: 0,
    },
    {
      address: UI_FIXTURE_CHANGE_ADDRESS,
      tokenAddress: UI_FIXTURE_CHANGE_ADDRESS,
      publicKey,
      pubkeyHash,
      changeIndex: 1,
      addressIndex: 0,
    },
  ];
}

export function getUiFixtureUtxos(): Record<string, UTXO[]> {
  return {
    [UI_FIXTURE_PRIMARY_ADDRESS]: [
      {
        wallet_id: UI_FIXTURE_WALLET_ID,
        address: UI_FIXTURE_PRIMARY_ADDRESS,
        height: 0,
        tx_hash: OUTBOX_TXID,
        tx_pos: 1,
        value: 12_500_000,
      },
    ],
    [UI_FIXTURE_CHANGE_ADDRESS]: [
      {
        wallet_id: UI_FIXTURE_WALLET_ID,
        address: UI_FIXTURE_CHANGE_ADDRESS,
        height: 842_120,
        tx_hash: CONFIRMED_TXID,
        tx_pos: 0,
        value: 87_500_000,
      },
    ],
  };
}

export function getUiFixtureTransactions(
  scenario = uiFixtureScenario()
): TransactionHistoryItem[] {
  if (scenario === 'history-empty' || scenario === 'history-error') {
    return [];
  }

  return [
    {
      height: 0,
      tx_hash: PENDING_TXID,
      timestamp: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      amount: 12_500_000,
      address: UI_FIXTURE_PRIMARY_ADDRESS,
      confirmations: 0,
    },
    {
      height: 842_120,
      tx_hash: CONFIRMED_TXID,
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      amount: 87_500_000,
      address: UI_FIXTURE_CHANGE_ADDRESS,
      confirmations: 6,
    },
  ];
}

export function getUiFixtureOutboundRecords(
  scenario = uiFixtureScenario()
): OutboundTransactionRecord[] {
  if (scenario === 'outbox-empty') return [];

  const ageMs =
    scenario === 'outbox-stale' || scenario === 'outbox-seen'
      ? 25 * 60 * 1000
      : 6 * 60 * 1000;
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  const state: OutboundTransactionRecord['state'] =
    scenario === 'outbox-stale'
      ? 'broadcasting'
      : scenario === 'outbox-seen'
        ? 'seen'
        : 'submitted';
  return [
    {
      txid: OUTBOX_TXID,
      rawTx: '00'.repeat(24),
      walletId: UI_FIXTURE_WALLET_ID,
      source: 'ui-fixture',
      sourceLabel: 'Demo payment',
      recipientSummary: UI_FIXTURE_PRIMARY_ADDRESS,
      amountSummary: '0.01250000 BCH',
      state,
      createdAt,
      updatedAt: createdAt,
      lastCheckedAt: createdAt,
      spentOutpoints: [{ tx_hash: CONFIRMED_TXID, tx_pos: 0 }],
      verificationPending:
        scenario !== 'outbox-stale' &&
        scenario !== 'outbox-seen' &&
        scenario !== 'outbox-unknown',
      verificationMessage:
        scenario === 'outbox-unknown'
          ? null
          : scenario === 'outbox-stale' || scenario === 'outbox-seen'
            ? null
            : 'Fixture: waiting for the network to report this payment.',
      lastError:
        scenario === 'outbox-unknown'
          ? 'Network timeout while checking whether this payment was seen.'
          : null,
    },
  ];
}

export function getUiFixtureTxids() {
  return {
    confirmed: CONFIRMED_TXID,
    pending: PENDING_TXID,
    outbox: OUTBOX_TXID,
  };
}

export function getUiFixtureWalletEffects(): Record<string, number> {
  return {
    [PENDING_TXID]: 12_500_000,
    [CONFIRMED_TXID]: 87_500_000,
  };
}

/**
 * A display-only BCH review for the local fixture harness. It intentionally
 * contains no valid signing material and must never reach a provider.
 */
export function getUiFixtureReview(
  recipient: string = UI_FIXTURE_PRIMARY_ADDRESS,
  amountBch = '0.1',
  changeAddress: string = UI_FIXTURE_CHANGE_ADDRESS
): ReviewState {
  const targetSats = Math.max(
    1,
    Math.round(Number(amountBch || 0) * 100_000_000)
  );
  const feeSats = 250;
  const totalSats = targetSats + feeSats;
  const changeSats = Math.max(0, 100_000_000 - totalSats);

  return {
    rawTx: '00'.repeat(180),
    feeSats,
    totalSats,
    finalOutputs: [
      { recipientAddress: recipient, amount: targetSats },
      ...(changeSats > 0
        ? [{ recipientAddress: changeAddress, amount: changeSats }]
        : []),
    ],
  };
}

export function getUiFixtureBuilderReview(scenario = uiFixtureScenario()): {
  rawTx: string;
  selectedUtxos: UTXO[];
  txOutputs: TransactionOutput[];
} {
  const selectedUtxo: UTXO = {
    wallet_id: UI_FIXTURE_WALLET_ID,
    address: UI_FIXTURE_PRIMARY_ADDRESS,
    height: 842_121,
    tx_hash: 'd'.repeat(64),
    tx_pos: 0,
    value: 10_000_000,
    ...(scenario === 'builder-token-error'
      ? {
          token: {
            category: 'e'.repeat(64),
            amount: 1n,
          },
        }
      : {}),
  };

  return {
    rawTx: '00'.repeat(120),
    selectedUtxos: [selectedUtxo],
    txOutputs: [
      {
        recipientAddress: UI_FIXTURE_PRIMARY_ADDRESS,
        amount: 8_000_000,
      },
      {
        recipientAddress: UI_FIXTURE_CHANGE_ADDRESS,
        amount: 1_999_750,
      },
    ],
  };
}

/** A public-only WalletConnect request for reviewing connector UI states. */
export function getUiFixtureWalletConnectRequest(): WalletKitTypes.SessionRequest {
  const inputLockingBytecode = cashAddressToLockingBytecode(
    UI_FIXTURE_PRIMARY_ADDRESS
  );
  const outputLockingBytecode = cashAddressToLockingBytecode(
    UI_FIXTURE_CHANGE_ADDRESS
  );
  if (
    typeof inputLockingBytecode === 'string' ||
    typeof outputLockingBytecode === 'string'
  ) {
    throw new Error('Unable to construct the UI fixture connector request.');
  }

  return {
    id: 9002,
    topic: 'ui-fixture-walletconnect',
    params: {
      request: {
        id: 9002,
        jsonrpc: '2.0',
        method: 'bch_signTransaction',
        params: {
          transaction: {
            version: 2,
            locktime: 0,
            inputs: [
              {
                outpointTransactionHash: Uint8Array.from(
                  Array.from({ length: 32 }, () => 4)
                ),
                outpointIndex: 0,
                sequenceNumber: 0xffffffff,
                unlockingBytecode: new Uint8Array(),
              },
            ],
            outputs: [
              {
                lockingBytecode: outputLockingBytecode.bytecode,
                valueSatoshis: 12_499_750n,
              },
            ],
          },
          sourceOutputs: [
            {
              lockingBytecode: inputLockingBytecode.bytecode,
              valueSatoshis: 12_500_000n,
            },
          ],
          broadcast: false,
          userPrompt: 'OPTN Wallet fixture payment',
        },
      },
    },
  } as unknown as WalletKitTypes.SessionRequest;
}

/** A public-only WizardConnect request for reviewing connector UI states. */
export function getUiFixtureWizardSignRequest(
  scenario = uiFixtureScenario()
): PendingSignRequest {
  const inputLockingBytecode = cashAddressToLockingBytecode(
    UI_FIXTURE_PRIMARY_ADDRESS
  );
  const outputLockingBytecode = cashAddressToLockingBytecode(
    UI_FIXTURE_CHANGE_ADDRESS
  );
  if (
    typeof inputLockingBytecode === 'string' ||
    typeof outputLockingBytecode === 'string'
  ) {
    throw new Error(
      'Unable to construct the UI fixture WizardConnect request.'
    );
  }

  const request = {
    action: 'sign_transaction_request',
    time: 1_735_000_000,
    sequence: 7,
    transaction: {
      transaction: {
        version: 2,
        locktime: 0,
        inputs: [
          {
            outpointTransactionHash: Uint8Array.from(
              Array.from({ length: 32 }, () => 5)
            ),
            outpointIndex: 0,
            sequenceNumber: 0xffffffff,
            unlockingBytecode: new Uint8Array(),
          },
        ],
        outputs: [
          {
            lockingBytecode: outputLockingBytecode.bytecode,
            valueSatoshis: 12_499_500n,
          },
        ],
      },
      sourceOutputs:
        scenario === 'wizardconnect-invalid'
          ? []
          : [
              {
                lockingBytecode: inputLockingBytecode.bytecode,
                valueSatoshis: 12_500_000n,
              },
            ],
      broadcast: false,
      userPrompt: 'OPTN Wallet WizardConnect fixture payment',
    },
    inputPaths: [[0, 'receive', 0]],
  } as unknown as SignTransactionRequest;

  return {
    connectionId: 'ui-fixture-wizard',
    request,
  };
}

export function getUiFixtureWizardConnections(): ActiveWizardConnections {
  return {
    'ui-fixture-wizard': {
      id: 'ui-fixture-wizard',
      uri: 'wiz://ui-fixture',
      status: {
        status: 'connected',
        error: null,
        sessionId: 'ui-fixture-session',
      },
      label: 'Fixture dApp',
      dappName: 'Fixture dApp',
      dappIcon: null,
      connectedAt: 1_735_000_000_000,
    },
  } as unknown as ActiveWizardConnections;
}

/** A public-only CashConnect action for reviewing its request-reported effect. */
export function getUiFixtureCashConnectAction(scenario = uiFixtureScenario()) {
  const session = {
    dappPubkey: 'fixture-dapp-public-key',
    dapp: {
      name: 'Fixture dApp',
      url: 'https://fixture.optn.example',
      description: 'A disposable CashConnect review fixture.',
    },
    chain: 'bchtest',
    template: {
      name: 'Swap',
    },
    allowedTokens: [],
    createdAt: 1_735_000_000,
  } as unknown as WalletSession;
  const request = {
    action: 'swap',
    params: { amountSatoshis: '150000' },
  } as ExecuteActionRequest;
  const response = {
    meta: {
      title: ['Swap BCH for PUSD'],
      description: [
        'The dApp prepared one transaction and reports the expected wallet change.',
      ],
    },
    data: { fixture: true },
    transactions:
      scenario === 'cashconnect-empty'
        ? []
        : scenario === 'cashconnect-multi'
          ? ['prepared-transaction-fixture-1', 'prepared-transaction-fixture-2']
          : ['prepared-transaction-fixture'],
    balanceChanges:
      scenario === 'cashconnect-empty' ? {} : { sats: -150_000n, PUSD: 25n },
  } as unknown as ExecuteActionResponse;

  return { session, request, response };
}

function fixtureQueryParams(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();

  const params = new URLSearchParams(window.location.search);
  const hashQueryIndex = window.location.hash.indexOf('?');
  if (hashQueryIndex >= 0) {
    const hashParams = new URLSearchParams(
      window.location.hash.slice(hashQueryIndex + 1)
    );
    hashParams.forEach((value, key) => {
      if (!params.has(key)) params.set(key, value);
    });
  }
  return params;
}

export function isUiFixtureEnabled(): boolean {
  return (
    import.meta.env.DEV &&
    import.meta.env.VITE_UI_FIXTURE === '1' &&
    fixtureQueryParams().has('ui-fixture')
  );
}

export function uiFixtureScenario(): string {
  return fixtureQueryParams().get('screen') || 'home';
}
