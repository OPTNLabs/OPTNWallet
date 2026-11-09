import { binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import type { BuiltCauldronTradeRequest } from './tx';

export type CauldronWalletEffect = {
  bchInputSats: bigint;
  bchReturnSats: bigint;
  netBchDebitSats: bigint;
  tokenInputAtomic: bigint;
  tokenReturnAtomic: bigint;
  netTokenDebitAtomic: bigint;
};

function toBigInt(value: number | bigint | undefined): bigint {
  if (value === undefined) return 0n;
  return typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
}

function normalizeCategory(category: string): string {
  return category.trim().toLowerCase().replace(/^0x/, '');
}

function lockingBytecodeHex(address: string): string {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') {
    throw new Error(`Invalid wallet change address: ${address}`);
  }
  return binToHex(decoded.bytecode);
}

export function deriveCauldronWalletEffect(
  built: Pick<
    BuiltCauldronTradeRequest,
    | 'walletInputs'
    | 'settlementOutputs'
    | 'changeAddress'
    | 'tokenChangeAddress'
  >,
  tokenCategory: string
): CauldronWalletEffect {
  const normalizedCategory = normalizeCategory(tokenCategory);
  const walletLockingBytecodes = new Set(
    [built.changeAddress, built.tokenChangeAddress]
      .filter((address): address is string => Boolean(address))
      .map(lockingBytecodeHex)
  );

  const bchInputSats = built.walletInputs.reduce(
    (total, input) => total + toBigInt(input.utxo.amount ?? input.utxo.value),
    0n
  );
  const tokenInputAtomic = built.walletInputs.reduce((total, input) => {
    const token = input.utxo.token;
    return token && normalizeCategory(token.category) === normalizedCategory
      ? total + toBigInt(token.amount)
      : total;
  }, 0n);

  let bchReturnSats = 0n;
  let tokenReturnAtomic = 0n;
  for (const output of built.settlementOutputs) {
    if (!walletLockingBytecodes.has(binToHex(output.lockingBytecode))) continue;
    bchReturnSats += output.valueSatoshis;
    if (
      output.token &&
      normalizeCategory(binToHex(output.token.category)) === normalizedCategory
    ) {
      tokenReturnAtomic += output.token.amount;
    }
  }

  return {
    bchInputSats,
    bchReturnSats,
    netBchDebitSats: bchInputSats - bchReturnSats,
    tokenInputAtomic,
    tokenReturnAtomic,
    netTokenDebitAtomic: tokenInputAtomic - tokenReturnAtomic,
  };
}
