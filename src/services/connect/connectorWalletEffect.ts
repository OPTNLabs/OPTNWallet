import { binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import type {
  ConnectorPreviewOutput,
  ConnectorTransactionPreview,
} from './transactionPreview';

export type ConnectorTokenEffect = {
  category: string;
  fungibleDelta: bigint;
  nftDelta: number;
};

export type ConnectorWalletEffect = {
  ownedInputCount: number;
  ownedOutputCount: number;
  bchDeltaSats: bigint;
  tokenEffects: ConnectorTokenEffect[];
};

function walletLockingBytecodes(addresses: string[]): Set<string> {
  const result = new Set<string>();
  for (const address of addresses) {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded !== 'string') result.add(binToHex(decoded.bytecode));
  }
  return result;
}

function addTokenEffect(
  effects: Map<string, { fungible: bigint; nfts: number }>,
  output: ConnectorPreviewOutput,
  direction: 1n | -1n
): void {
  if (!output.token) return;
  const category = binToHex(output.token.category);
  const current = effects.get(category) ?? { fungible: 0n, nfts: 0 };
  current.fungible += output.token.amount * direction;
  if (output.token.nft) current.nfts += direction === 1n ? 1 : -1;
  effects.set(category, current);
}

export function deriveConnectorWalletEffect(
  preview: ConnectorTransactionPreview,
  walletAddresses: string[]
): ConnectorWalletEffect {
  const lockingBytecodes = walletLockingBytecodes(walletAddresses);
  const ownedInputs = preview.inputs.filter((input) =>
    lockingBytecodes.has(binToHex(input.lockingBytecode))
  );
  const ownedOutputs = preview.outputs.filter((output) =>
    lockingBytecodes.has(binToHex(output.lockingBytecode))
  );
  const inputSats = ownedInputs.reduce(
    (total, input) => total + input.valueSatoshis,
    0n
  );
  const outputSats = ownedOutputs.reduce(
    (total, output) => total + output.valueSatoshis,
    0n
  );
  const tokenEffects = new Map<string, { fungible: bigint; nfts: number }>();
  for (const input of ownedInputs) addTokenEffect(tokenEffects, input, -1n);
  for (const output of ownedOutputs) addTokenEffect(tokenEffects, output, 1n);

  return {
    ownedInputCount: ownedInputs.length,
    ownedOutputCount: ownedOutputs.length,
    bchDeltaSats: outputSats - inputSats,
    tokenEffects: [...tokenEffects]
      .map(([category, effect]) => ({
        category,
        fungibleDelta: effect.fungible,
        nftDelta: effect.nfts,
      }))
      .filter((effect) => effect.fungibleDelta !== 0n || effect.nftDelta !== 0),
  };
}
