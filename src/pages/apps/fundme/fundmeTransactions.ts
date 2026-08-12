/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-asserted-optional-chain */
import {
  cashAddressToLockingBytecode,
  decodeTransaction,
} from '@bitauth/libauth';
import { Contract, ElectrumNetworkProvider, Network, TransactionBuilder, Unlocker } from 'cashscript';

import type { AddonSDK } from '../../../services/AddonsSDK';
import type { ChainCampaign } from './types';
import { FUNDME_CONTRACT_ARTIFACTS } from './contracts';
import { MasterCategoryID } from './values';

type FundMeActionResult = {
  txid: string | null;
};

function toNetwork(network: string | null | undefined): Network {
  return network === 'chipnet' ? Network.CHIPNET : Network.MAINNET;
}

function toCashscriptProvider(network: string | null | undefined) {
  return new ElectrumNetworkProvider(toNetwork(network));
}

function normalizeHex(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/^0x/i, '').replace(/^\\x/i, '');
}

function leToBe(hexLE: string): string {
  return normalizeHex(hexLE).match(/.{2}/g)?.reverse().join('') ?? '';
}

function hexToBigInt(hexLE: string): bigint {
  const be = leToBe(hexLE);
  return be ? BigInt(`0x${be}`) : 0n;
}

function toLittleEndianHexString(number: bigint, byteCount: number): string {
  const hex = number.toString(16).padStart(byteCount * 2, '0');
  return hex.match(/../g)?.reverse().join('') ?? '';
}

function parseCampaignId(commitment: string): number {
  return Number.parseInt(leToBe(commitment.slice(70, 80)) || '0', 16);
}

function campaignUtxoMatches(campaignId: number) {
  return (utxo: { token?: { category?: string; nft?: { capability?: string; commitment?: string } } }) =>
    normalizeHex(utxo.token?.category) === normalizeHex(MasterCategoryID) &&
    parseCampaignId(utxo.token?.nft?.commitment ?? '') === campaignId;
}

function makeContract(network: string | null | undefined, artifact: unknown) {
  return new Contract(artifact as never, [], {
    provider: toCashscriptProvider(network),
    addressType: 'p2sh32',
  });
}

async function getPrimaryAddress(sdk: AddonSDK): Promise<string> {
  const primary = await sdk.wallet.getPrimaryAddress();
  if (!primary) throw new Error('No primary wallet address available.');
  return primary;
}

async function getSignatureTemplate(sdk: AddonSDK, address: string) {
  return await sdk.signing.signatureTemplateForAddress(address);
}

async function broadcastBuiltHex(sdk: AddonSDK, rawHex: string): Promise<FundMeActionResult> {
  const sent = await sdk.tx.broadcast(rawHex);
  if (sent.errorMessage) throw new Error(sent.errorMessage);
  return { txid: sent.txid };
}

async function getWalletUtxos(sdk: AddonSDK) {
  const wallet = await sdk.utxos.listForWallet();
  return wallet.allUtxos ?? [];
}

function tokenCategoryHex(utxo: { token?: { category?: string } }): string {
  return normalizeHex(utxo.token?.category);
}

export async function donateToCampaign(args: {
  sdk: AddonSDK;
  campaign: ChainCampaign;
  amountBch: string;
}): Promise<FundMeActionResult> {
  const { sdk, campaign, amountBch } = args;
  const amount = BigInt(Math.round(Number(amountBch || '0') * 100_000_000));
  if (amount <= 0n) throw new Error('Donation amount must be greater than zero.');

  const network = sdk.wallet.getContext().network;
  const contract = makeContract(network, FUNDME_CONTRACT_ARTIFACTS.CashStarter);
  const campaignUtxos = await contract.getUtxos();
  const campaignUtxo = campaignUtxos.find(campaignUtxoMatches(campaign.id));
  if (!campaignUtxo) throw new Error(`Campaign #${campaign.id} is not currently spendable.`);

  const walletUtxos = await getWalletUtxos(sdk);
  const feeUtxo = walletUtxos.find((utxo) => !utxo.token && utxo.satoshis >= amount + 2000n);
  if (!feeUtxo) throw new Error('No raw BCH UTXO is available to fund the donation.');

  const primaryAddress = await getPrimaryAddress(sdk);
  const tokenAddress = await sdk.wallet.toTokenAddress(primaryAddress);
  const signatureTemplate = await getSignatureTemplate(sdk, primaryAddress);

  const pledgeId = campaignUtxo.token?.nft?.commitment ? parseCampaignId(campaignUtxo.token.nft.commitment) : 0;
  const newPledgeId = pledgeId + 1;
  const finalPledgeId = toLittleEndianHexString(BigInt(newPledgeId), 4);
  const campaignCommitment = normalizeHex(campaignUtxo.token?.nft?.commitment);
  const newCampaignCommitment = `${campaignCommitment.slice(0, 62)}${finalPledgeId}${campaign.id.toString(16).padStart(10, '0')}`;
  const pledgeAmountHex = toLittleEndianHexString(amount, 6);
  const campaignIdHex = campaign.id.toString(16).padStart(10, '0');
  const endBlockHex = campaign.endBlock.toString(16).padStart(8, '0');
  const newPledgeCommitment = `${pledgeAmountHex}${'0'.repeat(42)}${endBlockHex}${finalPledgeId}${campaignIdHex}`;

  const campaignNFTDetails = {
    amount: campaignUtxo.token?.amount ?? 0n,
    category: campaignUtxo.token?.category ?? MasterCategoryID,
    nft: {
      capability: campaignUtxo.token?.nft?.capability ?? 'minting',
      commitment: newCampaignCommitment,
    },
  };
  const pledgeNFTDetails = {
    amount: 0n,
    category: campaignUtxo.token?.category ?? MasterCategoryID,
    nft: {
      capability: 'none' as const,
      commitment: newPledgeCommitment,
    },
  };

  const tx = (contract as any).unlock.pledge(amount)
    .from(campaignUtxo)
    .fromP2PKH(feeUtxo, signatureTemplate)
    .to(AddressTokensCashStarter, campaignUtxo.satoshis + amount, campaignNFTDetails)
    .to(tokenAddress, 1000n, pledgeNFTDetails)
    .withoutChange()
    .withoutTokenChange();

  const changeAmount = feeUtxo.satoshis - (amount + 2000n);
  if (changeAmount > 546n) tx.to(primaryAddress, changeAmount);

  const rawHex = await tx.build();
  return await broadcastBuiltHex(sdk, rawHex);
}

export async function refundPledge(args: {
  sdk: AddonSDK;
  campaign: ChainCampaign;
}): Promise<FundMeActionResult> {
  const { sdk, campaign } = args;
  const network = sdk.wallet.getContext().network;
  const contract = makeContract(network, FUNDME_CONTRACT_ARTIFACTS.CashStarter);
  const refundContract = makeContract(network, FUNDME_CONTRACT_ARTIFACTS.CashStarterRefund);
  const primaryAddress = await getPrimaryAddress(sdk);
  const walletUtxos = await getWalletUtxos(sdk);
  const pledge = walletUtxos.find((utxo) =>
    !utxo.isPaperWallet &&
    tokenCategoryHex(utxo) === normalizeHex(MasterCategoryID) &&
    utxo.token?.nft?.capability === 'none' &&
    parseCampaignId(utxo.token?.nft?.commitment ?? '') === campaign.id
  );
  if (!pledge) throw new Error('No pledge NFT for this campaign was found in your wallet.');

  const [campaignUtxo] = (await contract.getUtxos()).filter(campaignUtxoMatches(campaign.id));
  if (!campaignUtxo) throw new Error(`Campaign #${campaign.id} not found.`);
  const [refundUtxo] = (await refundContract.getUtxos()).filter(
    (utxo) => normalizeHex(utxo.token?.category) === normalizeHex(MasterCategoryID) && utxo.token?.nft?.capability === 'minting'
  );
  if (!refundUtxo) throw new Error('Refund contract UTXO not found.');

  const p2pkhUnlocker: Unlocker = {
    generateLockingBytecode: () => {
      const result = cashAddressToLockingBytecode(primaryAddress);
      if (typeof result === 'string') throw new Error(result);
      return result.bytecode;
    },
    generateUnlockingBytecode: () => Uint8Array.from([]),
  };

  const refundSatoshis = hexToBigInt(normalizeHex(pledge.token?.nft?.commitment ?? '').slice(0, 12));
  const tx = await new TransactionBuilder({ provider: toCashscriptProvider(network) })
    .addInput(refundUtxo, (refundContract as any).unlock.refund())
    .addInput(campaignUtxo, (contract as any).unlock.externalFunction())
    .addInput(pledge as any, p2pkhUnlocker)
    .addOutput({
      to: AddressTokensCashStarterRefund,
      amount: refundUtxo.satoshis,
      token: {
        amount: refundUtxo.token?.amount!,
        category: refundUtxo.token?.category!,
        nft: refundUtxo.token?.nft!,
      },
    });

  if (campaignUtxo.satoshis > refundSatoshis) {
    tx.addOutput({
      to: AddressTokensCashStarter,
      amount: campaignUtxo.satoshis - refundSatoshis,
      token: {
        amount: campaignUtxo.token?.amount!,
        category: campaignUtxo.token?.category!,
        nft: {
          capability: campaignUtxo.token?.nft?.capability!,
          commitment: campaignUtxo.token?.nft?.commitment!,
        },
      },
    });
  }
  tx.addOutput({ to: primaryAddress, amount: refundSatoshis - 1000n });

  const rawHex = await tx.build();
  const decoded = decodeTransaction(Buffer.from(rawHex, 'hex'));
  if (typeof decoded === 'string') throw new Error(decoded);
  return await broadcastBuiltHex(sdk, rawHex);
}

export async function stopCampaign(args: {
  sdk: AddonSDK;
  campaign: ChainCampaign;
}): Promise<FundMeActionResult> {
  const { sdk, campaign } = args;
  const network = sdk.wallet.getContext().network;
  const contract = makeContract(network, FUNDME_CONTRACT_ARTIFACTS.CashStarter);
  const stopContract = makeContract(network, FUNDME_CONTRACT_ARTIFACTS.CashStarterStop);
  const campaignUtxo = (await contract.getUtxos()).find(campaignUtxoMatches(campaign.id));
  if (!campaignUtxo) throw new Error(`Campaign #${campaign.id} not found.`);
  const stopUtxo = (await stopContract.getUtxos()).find(
    (utxo) => normalizeHex(utxo.token?.category) === normalizeHex(MasterCategoryID) && utxo.token?.nft?.capability === 'minting'
  );
  if (!stopUtxo) throw new Error('Stop contract UTXO not found.');

  const blockHeight = await sdk.chain.getLatestBlock();
  const height =
    typeof blockHeight === 'object' && blockHeight && 'height' in blockHeight
      ? Number((blockHeight as { height?: unknown }).height ?? 0)
      : 0;
  const tx = await new TransactionBuilder({ provider: toCashscriptProvider(network) })
    .addInput(stopUtxo, (stopContract as any).unlock.stop())
    .addInput(campaignUtxo, (contract as any).unlock.externalFunction())
    .addOutput({
      to: AddressTokensCashStarterStop,
      amount: stopUtxo.satoshis,
      token: stopUtxo.token as any,
    })
    .setLocktime(height);

  if (campaignUtxo.satoshis > 1000n) {
    tx.addOutput({
      to: AddressTokensCashStarter,
      amount: campaignUtxo.satoshis - 1000n,
      token: {
        amount: campaignUtxo.token?.amount!,
        category: campaignUtxo.token?.category!,
        nft: {
          capability: 'mutable',
          commitment: campaignUtxo.token?.nft?.commitment!,
        },
      },
    });
  }

  return await broadcastBuiltHex(sdk, await tx.build());
}

export async function cancelCampaign(args: {
  sdk: AddonSDK;
  campaign: ChainCampaign;
}): Promise<FundMeActionResult> {
  const { sdk, campaign } = args;
  const network = sdk.wallet.getContext().network;
  const contract = makeContract(network, FUNDME_CONTRACT_ARTIFACTS.CashStarter);
  const cancelContract = makeContract(network, FUNDME_CONTRACT_ARTIFACTS.CashStarterCancel);
  const primaryAddress = await getPrimaryAddress(sdk);
  const campaignUtxo = (await contract.getUtxos()).find(campaignUtxoMatches(campaign.id));
  if (!campaignUtxo) throw new Error(`Campaign #${campaign.id} not found.`);
  const cancelUtxo = (await cancelContract.getUtxos()).find(
    (utxo) => normalizeHex(utxo.token?.category) === normalizeHex(MasterCategoryID) && utxo.token?.nft?.capability === 'minting'
  );
  if (!cancelUtxo) throw new Error('Cancel contract UTXO not found.');
  const walletUtxos = await getWalletUtxos(sdk);
  const userUtxo = walletUtxos.find((utxo) => !utxo.token && utxo.satoshis >= 1000n);
  if (!userUtxo) throw new Error('No BCH fee UTXO available.');
  const p2pkhUnlocker: Unlocker = {
    generateLockingBytecode: () => {
      const result = cashAddressToLockingBytecode(primaryAddress);
      if (typeof result === 'string') throw new Error(result);
      return result.bytecode;
    },
    generateUnlockingBytecode: () => Uint8Array.from([]),
  };
  const tx = await new TransactionBuilder({ provider: toCashscriptProvider(network) })
    .addInput(cancelUtxo, (cancelContract as any).unlock.cancel())
    .addInput(campaignUtxo, (contract as any).unlock.externalFunction())
    .addInput(userUtxo, p2pkhUnlocker)
    .addOutput({
      to: AddressTokensCashStarterCancel,
      amount: cancelUtxo.satoshis,
      token: cancelUtxo.token as any,
    });
  if (campaignUtxo.satoshis > 1000n) {
    tx.addOutput({
      to: AddressTokensCashStarter,
      amount: campaignUtxo.satoshis - 1000n,
      token: {
        amount: campaignUtxo.token?.amount!,
        category: campaignUtxo.token?.category!,
        nft: { capability: 'mutable', commitment: campaignUtxo.token?.nft?.commitment! },
      },
    });
  }
  tx.addOutput({ to: primaryAddress, amount: userUtxo.satoshis });
  return await broadcastBuiltHex(sdk, await tx.build());
}

export async function claimCampaign(args: {
  sdk: AddonSDK;
  campaign: ChainCampaign;
}): Promise<FundMeActionResult> {
  const { sdk, campaign } = args;
  const network = sdk.wallet.getContext().network;
  const contract = makeContract(network, FUNDME_CONTRACT_ARTIFACTS.CashStarter);
  const claimContract = makeContract(network, FUNDME_CONTRACT_ARTIFACTS.CashStarterClaim);
  const primaryAddress = await getPrimaryAddress(sdk);
  const campaignUtxo = (await contract.getUtxos()).find(campaignUtxoMatches(campaign.id));
  if (!campaignUtxo) throw new Error(`Campaign #${campaign.id} not found.`);
  const claimUtxo = (await claimContract.getUtxos()).find(
    (utxo) => normalizeHex(utxo.token?.category) === normalizeHex(MasterCategoryID) && utxo.token?.nft?.capability === 'minting'
  );
  if (!claimUtxo) throw new Error('Claim contract UTXO not found.');
  const walletUtxos = await getWalletUtxos(sdk);
  const userUtxo = walletUtxos.find((utxo) => !utxo.token && utxo.satoshis >= 1000n);
  if (!userUtxo) throw new Error('No BCH fee UTXO available.');

  const servicePKH = 'cda49032545f60a188bec92cbce5806ecfd65348';
  const serviceFee = campaignUtxo.satoshis * 15n / 1000n;
  const p2pkhUnlocker: Unlocker = {
    generateLockingBytecode: () => {
      const result = cashAddressToLockingBytecode(primaryAddress);
      if (typeof result === 'string') throw new Error(result);
      return result.bytecode;
    },
    generateUnlockingBytecode: () => Uint8Array.from([]),
  };
  const tx = await new TransactionBuilder({ provider: toCashscriptProvider(network), maximumFeeSatoshis: 2000n })
    .addInput(claimUtxo, (claimContract as any).unlock.claim(servicePKH, serviceFee))
    .addInput(campaignUtxo, (contract as any).unlock.externalFunction())
    .addInput(userUtxo, p2pkhUnlocker)
    .addOutput({
      to: AddressTokensCashStarterClaim,
      amount: claimUtxo.satoshis,
      token: claimUtxo.token as any,
    })
    .addOutput({
      to: primaryAddress,
      amount: (campaignUtxo.satoshis + userUtxo.satoshis) - (serviceFee + 1000n),
    })
    .addOutput({ to: 'bitcoincash:qrx6fypj230kpgvghmyje089sphvl4jnfqq4aduatz', amount: serviceFee });
  return await broadcastBuiltHex(sdk, await tx.build());
}
