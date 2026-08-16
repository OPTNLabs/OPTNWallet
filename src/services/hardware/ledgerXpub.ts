/**
 * Ledger account export — uses @ledgerhq/hw-app-btc the same way Ledger Live does.
 *
 * Critical: refuse to continue unless the Bitcoin Cash app is open on the device.
 * A wrong app (Bitcoin, dashboard, etc.) must not silently yield garbage keys.
 */

import Btc from '@ledgerhq/hw-app-btc';
// Deep import: not always re-exported from package root in this version.
import { getAppAndVersion } from '@ledgerhq/hw-app-btc/lib/getAppAndVersion';
import type Transport from '@ledgerhq/hw-transport';
import { Network } from '../../state/slices/networkSlice';
import { isDesktopPlatform } from '../../utils/platform';
import LedgerTransportNative from './LedgerTransportNative';
import TransportWebHID from '@ledgerhq/hw-transport-webhid';

/** BIP32 mainnet public version (same bytes BCH uses for xpub). */
const XPUB_VERSION_MAINNET = 0x0488b21e;
/** BIP32 testnet public version (chipnet). */
const XPUB_VERSION_TESTNET = 0x043587cf;

/** Names Ledger reports when the Bitcoin Cash app is open (case-insensitive). */
const BCH_APP_NAMES = new Set([
  'bitcoin cash',
  'bch',
  'bitcoin-cash',
]);

export type LedgerAppInfo = {
  name: string;
  version: string;
};

function xpubVersionForNetwork(network: Network): number {
  return network === Network.CHIPNET ? XPUB_VERSION_TESTNET : XPUB_VERSION_MAINNET;
}

async function openLedgerTransport(): Promise<Transport> {
  if (isDesktopPlatform()) {
    return LedgerTransportNative.open();
  }
  return TransportWebHID.create();
}

function createBtc(transport: Transport): Btc {
  return new Btc({ transport: transport as never, currency: 'bch' });
}

/**
 * Read the currently open app on the device.
 * Throws a clear error if we cannot talk to the device at all.
 */
export async function ledgerGetOpenApp(
  transport?: Transport
): Promise<LedgerAppInfo> {
  const owns = !transport;
  const t = transport ?? (await openLedgerTransport());
  try {
    const app = await getAppAndVersion(t);
    return { name: app.name, version: String(app.version) };
  } finally {
    if (owns) {
      try {
        await t.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Ensure the Bitcoin Cash app is the active app on the Ledger.
 * This is the check Electron Cash / Live effectively rely on before key ops.
 */
export async function ledgerAssertBitcoinCashApp(
  transport: Transport
): Promise<LedgerAppInfo> {
  let app: LedgerAppInfo;
  try {
    app = await ledgerGetOpenApp(transport);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot talk to the Ledger (is it unlocked and plugged in?). ${msg}`
    );
  }

  const normalized = app.name.trim().toLowerCase();
  if (!BCH_APP_NAMES.has(normalized) && !normalized.includes('cash')) {
    throw new Error(
      `Open the Bitcoin Cash app on the Ledger, then try again.\n` +
        `Currently open: “${app.name}” v${app.version}.\n` +
        `(Dashboard / Bitcoin / other apps will not work.)`
    );
  }
  return app;
}

/**
 * Export account-level xPub via the official Ledger Btc.getWalletXpub API
 * (not a hand-rolled pubkey||chainCode concat).
 */
export async function ledgerExportAccountXpub(
  network: Network,
  accountPath: string
): Promise<{
  xpub: string;
  path: string;
  firstAddress: string;
  app: LedgerAppInfo;
}> {
  const pathNoM = accountPath.replace(/^m\//, '');
  const segs = pathNoM.split('/').filter(Boolean);
  if (segs.length < 3) {
    throw new Error("Account path must look like m/44'/145'/0'");
  }

  const transport = await openLedgerTransport();
  try {
    const app = await ledgerAssertBitcoinCashApp(transport);
    const btc = createBtc(transport);

    const xpub = await btc.getWalletXpub({
      path: pathNoM,
      xpubVersion: xpubVersionForNetwork(network),
    });
    if (!xpub || typeof xpub !== 'string') {
      throw new Error('Ledger returned an empty xPub.');
    }
    // Sanity: BIP32 base58 xpub/tpub prefix
    if (
      !xpub.startsWith('xpub') &&
      !xpub.startsWith('tpub') &&
      !xpub.startsWith('Ypub') &&
      !xpub.startsWith('Zpub') &&
      !xpub.startsWith('upub') &&
      !xpub.startsWith('vpub')
    ) {
      throw new Error(
        `Ledger returned a value that does not look like an xPub (got ${xpub.slice(0, 8)}…). ` +
          'Confirm Bitcoin Cash app is open and derivation is correct.'
      );
    }

    // Address at account/0/0 for display confirmation
    const leaf = await btc.getWalletPublicKey(`${pathNoM}/0/0`, {
      verify: false,
      format: 'cashaddr',
    });

    return {
      xpub,
      path: accountPath.startsWith('m/') ? accountPath : `m/${pathNoM}`,
      firstAddress: leaf.bitcoinAddress,
      app,
    };
  } finally {
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
  }
}
