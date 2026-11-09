import type { TransactionOutput, UTXO } from '../../types/types';

function amount(value: number | bigint | undefined): bigint {
  if (value === undefined) throw new Error('Transaction value is missing');
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error('Transaction value is negative');
  return parsed;
}

export function summarizeBuilderReview(
  inputs: UTXO[],
  outputs: TransactionOutput[]
): { feeSats: number; unaccountedTokens: string[] } {
  if (!inputs.length || !outputs.length) {
    throw new Error('Transaction inputs or outputs are missing');
  }
  const inputSats = inputs.reduce(
    (sum, input) => sum + amount(input.amount ?? input.value),
    0n
  );
  const outputSats = outputs.reduce(
    (sum, output) => sum + ('opReturn' in output ? 0n : amount(output.amount)),
    0n
  );
  const fee = inputSats - outputSats;
  if (fee < 0n || fee > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Transaction fee cannot be verified');
  }

  const inputTokens = new Map<string, { fungible: bigint; nfts: number }>();
  const outputTokens = new Map<string, { fungible: bigint; nfts: number }>();
  const addToken = (
    map: Map<string, { fungible: bigint; nfts: number }>,
    token: NonNullable<UTXO['token']>
  ) => {
    const current = map.get(token.category) ?? { fungible: 0n, nfts: 0 };
    current.fungible += amount(token.amount);
    if (token.nft) current.nfts += 1;
    map.set(token.category, current);
  };
  for (const input of inputs)
    if (input.token) addToken(inputTokens, input.token);
  for (const output of outputs) {
    if (!('opReturn' in output) && output.token)
      addToken(outputTokens, output.token);
  }
  const unaccountedTokens = [...inputTokens].flatMap(([category, input]) => {
    const output = outputTokens.get(category);
    return (output?.fungible ?? 0n) < input.fungible ||
      (output?.nfts ?? 0) < input.nfts
      ? [category]
      : [];
  });
  return { feeSats: Number(fee), unaccountedTokens };
}
