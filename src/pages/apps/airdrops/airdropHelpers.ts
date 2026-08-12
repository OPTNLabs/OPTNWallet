type ParsedRecipientRow = {
  label: string;
  address: string;
  notes: string;
  source: 'paste';
};

export type AmountRuleMode = 'fixed' | 'has_token' | 'tiered_balance';

export function looksLikeAddress(value: string) {
  const trimmed = value.trim();
  return /^(bitcoincash:|bchtest:|simpleledger:|etoken:|ecash:)/i.test(trimmed);
}

function normalizeParsedRecipient(
  value:
    | string
    | {
        address?: string;
        cashaddr?: string;
        recipientAddress?: string;
        destination_address?: string;
        label?: string;
        name?: string;
        notes?: string;
        memo?: string;
      },
  index: number
): ParsedRecipientRow | null {
  if (typeof value === 'string') {
    const address = value.trim();
    if (!looksLikeAddress(address)) return null;
    return { label: `Recipient ${index + 1}`, address, notes: '', source: 'paste' };
  }

  const address =
    value.address?.trim() ||
    value.cashaddr?.trim() ||
    value.recipientAddress?.trim() ||
    value.destination_address?.trim() ||
    '';
  if (!looksLikeAddress(address)) return null;
  return {
    label: value.label?.trim() || value.name?.trim() || `Recipient ${index + 1}`,
    address,
    notes: value.notes?.trim() || value.memo?.trim() || '',
    source: 'paste',
  };
}

export function shortenMiddle(value: string, head = 12, tail = 8) {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function normalizeAddressKey(address: string) {
  return address.trim().toLowerCase();
}

export function parseRecipientJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed || !['[', '{'].includes(trimmed[0])) return null;

  try {
    const parsed = JSON.parse(trimmed) as
      | unknown[]
      | {
          recipients?: unknown[];
          addresses?: unknown[];
          items?: unknown[];
        };

    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.recipients)
        ? parsed.recipients
        : Array.isArray(parsed.addresses)
          ? parsed.addresses
          : Array.isArray(parsed.items)
            ? parsed.items
            : null;

    if (!list) return null;

    return list
      .map((entry, index) =>
        normalizeParsedRecipient(
          typeof entry === 'string' || (entry && typeof entry === 'object')
            ? (entry as string | Parameters<typeof normalizeParsedRecipient>[0])
            : '',
          index
        )
      )
      .filter((row): row is ParsedRecipientRow => Boolean(row));
  } catch {
    return null;
  }
}

export function parseRecipientLineEntries(line: string, startingIndex: number) {
  const normalized = line.replace(/\t/g, ',').replace(/;/g, ',').trim();
  if (!normalized) return [];

  const parts = normalized
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length > 1 && parts.every((part) => looksLikeAddress(part))) {
    return parts.map((address, index) => ({
      label: `Recipient ${startingIndex + index + 1}`,
      address,
      notes: '',
      source: 'paste' as const,
    }));
  }

  if (parts.length === 1) {
    const only = parts[0];
    if (looksLikeAddress(only)) {
      return [
        {
          label: `Recipient ${startingIndex + 1}`,
          address: only,
          notes: '',
          source: 'paste' as const,
        },
      ];
    }

    const looseAddresses = only
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => looksLikeAddress(part));

    if (looseAddresses.length === 0) return [];

    return looseAddresses.map((address, index) => ({
      label: `Recipient ${startingIndex + index + 1}`,
      address,
      notes: '',
      source: 'paste' as const,
    }));
  }

  const addressIndex = parts.findIndex((part) => looksLikeAddress(part));
  if (addressIndex === -1) {
    const looseAddresses = normalized
      .split(/[\s,;]+/)
      .map((part) => part.trim())
      .filter((part) => looksLikeAddress(part));

    return looseAddresses.map((address, index) => ({
      label: `Recipient ${startingIndex + index + 1}`,
      address,
      notes: '',
      source: 'paste' as const,
    }));
  }

  const address = parts[addressIndex];
  const remaining = parts.filter((_, partIndex) => partIndex !== addressIndex);
  const label = remaining[0] || `Recipient ${startingIndex + 1}`;
  const notes = remaining.slice(1).join(', ');

  return [
    {
      label,
      address,
      notes,
      source: 'paste' as const,
    },
  ];
}

export function parseRecipientText(text: string) {
  const jsonRows = parseRecipientJson(text);
  if (jsonRows && jsonRows.length > 0) return jsonRows;

  const lineRows = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<ParsedRecipientRow[]>((rows, line) => {
      const parsedRows = parseRecipientLineEntries(line, rows.length);
      rows.push(...parsedRows);
      return rows;
    }, []);

  if (lineRows.length > 0) return lineRows;

  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => looksLikeAddress(part))
    .map((address, index) => ({
      label: `Recipient ${index + 1}`,
      address,
      notes: '',
      source: 'paste' as const,
    }));
}

export function describeAmountRule(mode: AmountRuleMode) {
  switch (mode) {
    case 'has_token':
      return 'Only matching holders';
    case 'tiered_balance':
      return 'Balance tiers';
    case 'fixed':
    default:
      return 'Same for everyone';
  }
}

export function hasAirdropTokenHoldings(asset: {
  tokenBalance: string;
  nftCommitments: string[];
}) {
  try {
    return BigInt(asset.tokenBalance || '0') > 0n || asset.nftCommitments.length > 0;
  } catch {
    return asset.nftCommitments.length > 0;
  }
}

export function normalizeTokenHolderBalance(args: {
  ftBalance: string;
  utxoCount: number;
}) {
  try {
    const ftBalance = BigInt(args.ftBalance || '0');
    if (ftBalance > 0n) return ftBalance;
  } catch {
    // Fall through to the NFT-aware presence check below.
  }

  return args.utxoCount > 0 ? 1n : 0n;
}
