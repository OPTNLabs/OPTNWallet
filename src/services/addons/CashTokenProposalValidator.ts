import type {
  AddonCashTokenIntent,
  AddonTransactionProposal,
} from '../AddonsSDK';

type NftState = {
  category: string;
  capability: 'none' | 'mutable' | 'minting';
  commitment: string;
};

export type CashTokenValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/** Consensus bounds from BCH CashTokens encoding. */
export const MAX_CASHTOKEN_AMOUNT = 9_223_372_036_854_775_807n;
export const MAX_NFT_COMMITMENT_HEX_LENGTH = 80;

function nftKey(nft: NftState): string {
  return `${nft.category}:${nft.capability}:${nft.commitment}`;
}

function inputNfts(proposal: AddonTransactionProposal): NftState[] {
  return proposal.inputs.flatMap((input) =>
    input.tokenCategory && input.tokenNft
      ? [{ category: input.tokenCategory, ...input.tokenNft }]
      : []
  );
}

function outputNfts(proposal: AddonTransactionProposal): NftState[] {
  return proposal.outputs.flatMap((output) =>
    'opReturn' in output || !output.token?.nft
      ? []
      : [{ category: output.token.category, ...output.token.nft }]
  );
}

function nftCounts(nfts: NftState[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const nft of nfts) {
    const key = nftKey(nft);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function validateTokenState(
  category: string | undefined,
  amount: string | number | bigint | undefined,
  nft: NftState | undefined,
  label: string,
  errors: string[]
) {
  if (!category && amount === undefined && !nft) return;
  if (!category || amount === undefined) {
    errors.push(`${label} must include a category and amount`);
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(category)) {
    errors.push(`${label} category is invalid`);
  }
  let tokenAmount: bigint;
  try {
    tokenAmount = BigInt(amount);
  } catch {
    errors.push(`${label} amount is invalid`);
    return;
  }
  if (tokenAmount < 0n || tokenAmount > MAX_CASHTOKEN_AMOUNT) {
    errors.push(`${label} amount is outside the CashTokens range`);
  }
  if (!nft && tokenAmount === 0n) {
    errors.push(`${label} fungible amount must be positive`);
  }
  if (nft) {
    if (!['none', 'mutable', 'minting'].includes(nft.capability)) {
      errors.push(`${label} NFT capability is invalid`);
    }
    if (
      !/^[0-9a-f]*$/.test(nft.commitment) ||
      nft.commitment.length % 2 !== 0 ||
      nft.commitment.length > MAX_NFT_COMMITMENT_HEX_LENGTH
    ) {
      errors.push(`${label} NFT commitment is invalid`);
    }
  }
}

function appendNftMultisetErrors(
  inputNfts: NftState[],
  outputNfts: NftState[],
  errors: string[],
  message = 'NFT state is not conserved'
) {
  const counts = nftCounts(inputNfts);
  for (const nft of outputNfts) {
    const key = nftKey(nft);
    counts.set(key, (counts.get(key) ?? 0) - 1);
  }
  for (const [key, count] of counts) {
    if (count !== 0) errors.push(`${message}: ${key}`);
  }
}

function appendNftDeltaErrors(
  inputNfts: NftState[],
  outputNfts: NftState[],
  removed: NftState | undefined,
  added: NftState | undefined,
  errors: string[]
) {
  const expectedInputs = [...inputNfts];
  if (removed) {
    const removedIndex = findNft(expectedInputs, removed);
    if (removedIndex >= 0) expectedInputs.splice(removedIndex, 1);
  }
  if (added) expectedInputs.push(added);
  appendNftMultisetErrors(expectedInputs, outputNfts, errors);
}

function fungibleTotals(proposal: AddonTransactionProposal) {
  const inputs = new Map<string, bigint>();
  const outputs = new Map<string, bigint>();
  for (const input of proposal.inputs) {
    if (input.tokenCategory && input.tokenAmount !== undefined) {
      try {
        inputs.set(
          input.tokenCategory,
          (inputs.get(input.tokenCategory) ?? 0n) + BigInt(input.tokenAmount)
        );
      } catch {
        // validateTokenState records the user-facing malformed amount error.
        // Do not throw again while computing aggregate deltas.
      }
    }
  }
  for (const output of proposal.outputs) {
    if ('opReturn' in output || !output.token) continue;
    try {
      outputs.set(
        output.token.category,
        (outputs.get(output.token.category) ?? 0n) +
          BigInt(output.token.amount)
      );
    } catch {
      // validateTokenState records the malformed amount error.
    }
  }
  return { inputs, outputs };
}

function validateFungibleDelta(
  intent: AddonCashTokenIntent | undefined,
  inputs: Map<string, bigint>,
  outputs: Map<string, bigint>,
  errors: string[]
) {
  const categories = new Set([...inputs.keys(), ...outputs.keys()]);
  for (const category of categories) {
    const input = inputs.get(category) ?? 0n;
    const output = outputs.get(category) ?? 0n;
    const delta = output - input;

    if (!intent || intent.kind === 'transfer' || intent.kind === 'mutate-nft') {
      if (delta !== 0n) {
        errors.push(
          `Fungible amount for ${category} changed without an explicit intent`
        );
      }
      continue;
    }

    if (intent.category !== category) {
      if (delta !== 0n)
        errors.push(`Token intent category does not match ${category}`);
      continue;
    }

    let intentAmount: bigint | undefined;
    if ('amount' in intent && intent.amount !== undefined) {
      try {
        intentAmount = BigInt(intent.amount);
      } catch {
        errors.push('Token intent amount is invalid');
      }
    }

    if (intent.kind === 'mint-fungible' && intentAmount !== undefined && delta !== intentAmount) {
      errors.push(`Fungible mint delta for ${category} does not match intent`);
    } else if (intent.kind === 'mint-nft' && delta !== 0n) {
      errors.push(`NFT mint cannot change fungible amount for ${category}`);
    } else if (intent.kind === 'burn') {
      const expected =
        intentAmount === undefined ? 0n : -intentAmount;
      if (delta !== expected) {
        errors.push(
          `Fungible burn delta for ${category} does not match intent`
        );
      }
    }
  }
}

function findNft(nfts: NftState[], wanted: NftState): number {
  return nfts.findIndex(
    (nft) =>
      nft.category === wanted.category &&
      nft.capability === wanted.capability &&
      nft.commitment === wanted.commitment
  );
}

function isGenesisInput(
  proposal: AddonTransactionProposal,
  category: string
): boolean {
  return proposal.inputs.some(
    (input) =>
      input.txid === category &&
      input.vout === 0 &&
      input.tokenCategory === undefined &&
      input.tokenAmount === undefined &&
      input.tokenNft === undefined
  );
}

function validateIntent(intent: AddonCashTokenIntent | undefined, errors: string[]) {
  if (!intent || intent.kind === 'transfer') return;
  if (!/^[0-9a-f]{64}$/.test(intent.category)) {
    errors.push('Token intent category is invalid');
  }
  if ('amount' in intent && intent.amount !== undefined) {
    try {
      const amount = BigInt(intent.amount);
      if (amount <= 0n || amount > MAX_CASHTOKEN_AMOUNT) {
        errors.push('Token intent amount is outside the positive CashTokens range');
      }
    } catch {
      errors.push('Token intent amount is invalid');
    }
  }
  if (intent.kind === 'mint-fungible' && !('amount' in intent)) {
    errors.push('Fungible mint intent requires an amount');
  }
  if (intent.kind === 'burn' && intent.amount === undefined && !intent.nft) {
    errors.push('Burn intent must specify a fungible amount or NFT');
  }
}

export function validateCashTokenProposal(
  proposal: AddonTransactionProposal
): CashTokenValidationResult {
  const errors: string[] = [];
  for (const [index, input] of proposal.inputs.entries()) {
    validateTokenState(
      input.tokenCategory,
      input.tokenAmount,
      input.tokenNft
        ? { category: input.tokenCategory ?? '', ...input.tokenNft }
        : undefined,
      `Input ${index} token`,
      errors
    );
  }
  for (const [index, output] of proposal.outputs.entries()) {
    if ('opReturn' in output || !output.token) continue;
    validateTokenState(
      output.token.category,
      output.token.amount,
      output.token.nft
        ? { category: output.token.category, ...output.token.nft }
        : undefined,
      `Output ${index} token`,
      errors
    );
  }
  const { inputs, outputs } = fungibleTotals(proposal);
  const inNfts = inputNfts(proposal);
  const outNfts = outputNfts(proposal);
  const intent = proposal.tokenIntent;

  validateIntent(intent, errors);

  validateFungibleDelta(intent, inputs, outputs, errors);

  if (!intent || intent.kind === 'transfer') {
    appendNftMultisetErrors(inNfts, outNfts, errors);
  } else if (intent.kind === 'mint-fungible') {
    if (!isGenesisInput(proposal, intent.category)) {
      errors.push(
        'Fungible mint requires a token-genesis input at vout 0 whose txid matches the category'
      );
    }
    if (intent.nft) {
      const minted: NftState = {
        category: intent.category,
        ...intent.nft,
      };
      appendNftDeltaErrors(inNfts, outNfts, undefined, minted, errors);
    } else {
      appendNftMultisetErrors(inNfts, outNfts, errors);
    }
  } else if (intent.kind === 'mint-nft') {
    const genesis = isGenesisInput(proposal, intent.category);
    const authority = inNfts.find(
      (nft) => nft.category === intent.category && nft.capability === 'minting'
    );
    if (!authority && !genesis) {
      errors.push('NFT mint requires a minting-capability input authority');
    }
    const minted: NftState = {
      category: intent.category,
      capability: intent.capability,
      commitment: intent.commitment,
    };
    const inputCount = inNfts.filter(
      (nft) => nftKey(nft) === nftKey(minted)
    ).length;
    const outputCount = outNfts.filter(
      (nft) => nftKey(nft) === nftKey(minted)
    ).length;
    if (outputCount !== inputCount + 1) {
      errors.push('NFT mint output does not add exactly one requested NFT');
    }
    if (genesis) {
      appendNftDeltaErrors([], outNfts, undefined, minted, errors);
    } else {
      appendNftDeltaErrors(inNfts, outNfts, undefined, minted, errors);
    }
  } else if (intent.kind === 'mutate-nft') {
    const source: NftState = { category: intent.category, ...intent.source };
    const target: NftState = { category: intent.category, ...intent.target };
    if (source.capability === 'none') {
      errors.push('An immutable NFT cannot be mutated');
    }
    if (source.capability === 'mutable' && target.capability === 'minting') {
      errors.push('A mutable NFT cannot be upgraded to minting capability');
    }
    if (findNft(inNfts, source) === -1) {
      errors.push('NFT mutation source does not match an input NFT');
    }
    if (findNft(outNfts, target) === -1) {
      errors.push('NFT mutation target does not match an output NFT');
    }
    appendNftDeltaErrors(inNfts, outNfts, source, target, errors);
  } else if (intent.kind === 'burn') {
    if (intent.amount === undefined && !intent.nft) {
      errors.push('Burn intent must specify a fungible amount or NFT');
    }
    if (intent.amount !== undefined && intent.nft) {
      errors.push('Burn intent must specify either fungible amount or NFT');
    }
    if (intent.nft) {
      const burned: NftState = { category: intent.category, ...intent.nft };
      if (findNft(inNfts, burned) === -1) {
        errors.push('NFT burn intent does not match an input NFT');
      }
      appendNftDeltaErrors(inNfts, outNfts, burned, undefined, errors);
    } else {
      appendNftMultisetErrors(inNfts, outNfts, errors);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
