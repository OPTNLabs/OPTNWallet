import type { AddonSDK } from '../../../../services/AddonsSDK';
import {
  decodeMemoActionFromLockingBytecode,
  deriveAddressFromLockingBytecode,
  deriveAddressFromUnlockingBytecode,
  type DecodedMemoRow,
} from './memoDecoder';
import { stripHexPrefix } from './opReturn';

export const CHAINGRAPH_ENDPOINT = 'https://gql.chaingraph.pat.mn/v1/graphql';

export const MEMO_PREFIX = {
  any: '6a026d',
  set_name: '6a026d01',
  post: '6a026d02',
  reply: '6a026d03',
  like_tip: '6a026d04',
  set_profile_text: '6a026d05',
  follow: '6a026d06',
  unfollow: '6a026d07',
  set_profile_picture: '6a026d0a',
  post_topic: '6a026d0c',
} as const;

export type MemoPageCursor = {
  internalId: bigint;
  outputIndex: number;
};

type SearchOutputRow = {
  transaction_hash: string;
  output_index: number;
  locking_bytecode: string;
  transaction: {
    internal_id: string | number;
    hash: string;
    inputs?: Array<{
      unlocking_bytecode?: string | null;
      outpoint_transaction_hash?: string | null;
      outpoint_index?: number | null;
    }>;
  };
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type SearchData = {
  search_output_prefix: SearchOutputRow[];
};

function buildSearchQueryPage1(prefixLiteral?: string) {
  const prefixArg = prefixLiteral
    ? `{ locking_bytecode_prefix_hex: "${prefixLiteral}" }`
    : '{ locking_bytecode_prefix_hex: $prefix }';
  return `
query MemoSearchPage1(${prefixLiteral ? '' : '$prefix: String!, '}$limit: Int!) {
  search_output_prefix(
    args: ${prefixArg}
    limit: $limit
    order_by: { transaction: { internal_id: desc }, output_index: asc }
  ) {
    transaction_hash
    output_index
    locking_bytecode
    transaction {
      internal_id
      hash
      inputs(limit: 1) {
        unlocking_bytecode
        outpoint_transaction_hash
        outpoint_index
      }
    }
  }
}
`;
}

function buildSearchQueryOlder(prefixLiteral?: string) {
  const prefixArg = prefixLiteral
    ? `{ locking_bytecode_prefix_hex: "${prefixLiteral}" }`
    : '{ locking_bytecode_prefix_hex: $prefix }';
  return `
query MemoSearchOlder(${prefixLiteral ? '' : '$prefix: String!, '}$limit: Int!, $cursorInternalId: bigint!, $cursorOutputIndex: bigint!) {
  search_output_prefix(
    args: ${prefixArg}
    limit: $limit
    where: {
      _or: [
        { transaction: { internal_id: { _lt: $cursorInternalId } } }
        {
          _and: [
            { transaction: { internal_id: { _eq: $cursorInternalId } } }
            { output_index: { _gt: $cursorOutputIndex } }
          ]
        }
      ]
    }
    order_by: { transaction: { internal_id: desc }, output_index: asc }
  ) {
    transaction_hash
    output_index
    locking_bytecode
    transaction {
      internal_id
      hash
      inputs(limit: 1) {
        unlocking_bytecode
        outpoint_transaction_hash
        outpoint_index
      }
    }
  }
}
`;
}

const SEARCH_QUERY_PAGE_1 = buildSearchQueryPage1();
const SEARCH_QUERY_OLDER = buildSearchQueryOlder();

export const MEMO_ACTION_QUERIES: Record<
  string,
  { page1: string; older: string }
> = {
  set_name: {
    page1: buildSearchQueryPage1(MEMO_PREFIX.set_name),
    older: buildSearchQueryOlder(MEMO_PREFIX.set_name),
  },
  post: {
    page1: buildSearchQueryPage1(MEMO_PREFIX.post),
    older: buildSearchQueryOlder(MEMO_PREFIX.post),
  },
  reply: {
    page1: buildSearchQueryPage1(MEMO_PREFIX.reply),
    older: buildSearchQueryOlder(MEMO_PREFIX.reply),
  },
  like_tip: {
    page1: buildSearchQueryPage1(MEMO_PREFIX.like_tip),
    older: buildSearchQueryOlder(MEMO_PREFIX.like_tip),
  },
  set_profile_text: {
    page1: buildSearchQueryPage1(MEMO_PREFIX.set_profile_text),
    older: buildSearchQueryOlder(MEMO_PREFIX.set_profile_text),
  },
  follow: {
    page1: buildSearchQueryPage1(MEMO_PREFIX.follow),
    older: buildSearchQueryOlder(MEMO_PREFIX.follow),
  },
  unfollow: {
    page1: buildSearchQueryPage1(MEMO_PREFIX.unfollow),
    older: buildSearchQueryOlder(MEMO_PREFIX.unfollow),
  },
  set_profile_picture: {
    page1: buildSearchQueryPage1(MEMO_PREFIX.set_profile_picture),
    older: buildSearchQueryOlder(MEMO_PREFIX.set_profile_picture),
  },
  post_topic: {
    page1: buildSearchQueryPage1(MEMO_PREFIX.post_topic),
    older: buildSearchQueryOlder(MEMO_PREFIX.post_topic),
  },
};

function toBigInt(value: string | number): bigint {
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const s = String(value).trim();
  return BigInt(s || '0');
}

function firstInputUnlockingHex(row: SearchOutputRow): string | null {
  const first = Array.isArray(row.transaction.inputs)
    ? row.transaction.inputs[0]
    : undefined;
  if (!first?.unlocking_bytecode) return null;
  return String(first.unlocking_bytecode);
}

function firstInputPrevout(row: SearchOutputRow): {
  txHash: string;
  index: number;
} | null {
  const first = Array.isArray(row.transaction.inputs)
    ? row.transaction.inputs[0]
    : undefined;
  if (!first) return null;

  const txHash = stripHexPrefix(String(first.outpoint_transaction_hash ?? ''));
  const index = Number(first.outpoint_index ?? -1);
  if (!txHash || txHash.length !== 64 || index < 0) return null;
  return { txHash, index };
}

function prevoutKey(prev: { txHash: string; index: number }): string {
  return `${prev.txHash}:${prev.index}`;
}

async function resolvePrevoutAddresses(params: {
  sdk: AddonSDK;
  network: string | null | undefined;
  prevouts: Array<{ txHash: string; index: number }>;
}): Promise<Map<string, string>> {
  const unique = new Map<string, { txHash: string; index: number }>();
  for (const p of params.prevouts) {
    unique.set(prevoutKey(p), p);
  }
  const entries = Array.from(unique.values());
  if (entries.length === 0) return new Map();

  const clauses = entries
    .map(
      (p) =>
        `{ transaction_hash: { _eq: "\\\\x${p.txHash}" }, output_index: { _eq: ${p.index} } }`
    )
    .join(', ');

  const query = `query {
    output(where: { _or: [${clauses}] }) {
      transaction_hash
      output_index
      locking_bytecode
    }
  }`;

  type OutputRow = {
    transaction_hash: string;
    output_index: number;
    locking_bytecode: string;
  };

  const resp = await params.sdk.http.fetchJson<
    GraphQLResponse<{ output: OutputRow[] }>
  >(CHAINGRAPH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName: null,
      query,
      variables: {},
    }),
  });

  if (resp.errors && resp.errors.length > 0) {
    const msg = resp.errors.map((e) => e.message || 'GraphQL error').join('; ');
    throw new Error(`Chaingraph prevout query failed: ${msg}`);
  }

  const out = new Map<string, string>();
  for (const row of resp.data?.output ?? []) {
    const txHash = stripHexPrefix(row.transaction_hash);
    const index = Number(row.output_index ?? -1);
    if (!txHash || index < 0) continue;

    const addr = deriveAddressFromLockingBytecode(
      row.locking_bytecode,
      params.network
    );
    if (!addr) continue;
    out.set(`${txHash}:${index}`, addr);
  }
  return out;
}

async function queryMemoRows(params: {
  sdk: AddonSDK;
  prefix: string;
  limit: number;
  cursor?: MemoPageCursor | null;
}): Promise<SearchOutputRow[]> {
  const { sdk, prefix, limit, cursor } = params;

  const query = cursor === null || cursor === undefined
    ? SEARCH_QUERY_PAGE_1
    : SEARCH_QUERY_OLDER;
  const variables =
    cursor === null || cursor === undefined
      ? { prefix, limit }
      : {
          prefix,
          limit,
          cursorInternalId: cursor.internalId.toString(),
          cursorOutputIndex: String(cursor.outputIndex),
        };

  const resp = await sdk.http.fetchJson<GraphQLResponse<SearchData>>(
    CHAINGRAPH_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: null,
        query,
        variables,
      }),
    }
  );

  if (resp.errors && resp.errors.length > 0) {
    const msg = resp.errors.map((e) => e.message || 'GraphQL error').join('; ');
    throw new Error(`Chaingraph query failed: ${msg}`);
  }

  return Array.isArray(resp.data?.search_output_prefix)
    ? resp.data.search_output_prefix
    : [];
}

export async function fetchDecodedMemoPage(params: {
  sdk: AddonSDK;
  network: string | null | undefined;
  limit: number;
  cursor?: MemoPageCursor | null;
  prefix?: string;
}) {
  const rows = await queryMemoRows({
    sdk: params.sdk,
    prefix: params.prefix ?? MEMO_PREFIX.any,
    limit: params.limit,
    cursor: params.cursor,
  });

  const decoded: DecodedMemoRow[] = [];
  const unresolvedByPrevout = new Map<
    string,
    { rowIndex: number; prevout: { txHash: string; index: number } }
  >();

  for (const row of rows) {
    const action = decodeMemoActionFromLockingBytecode(row.locking_bytecode);
    if (!action) continue;

    const txid = stripHexPrefix(row.transaction_hash || row.transaction.hash);
    const outputIndex = Number(row.output_index ?? 0);
    const internalId = toBigInt(row.transaction.internal_id);
    const actorAddress = deriveAddressFromUnlockingBytecode(
      firstInputUnlockingHex(row),
      params.network
    );

    decoded.push({
      id: `${txid}:${outputIndex}`,
      txid,
      outputIndex,
      internalId,
      action,
      actorAddress,
    });

    if (!actorAddress) {
      const prevout = firstInputPrevout(row);
      if (prevout) {
        unresolvedByPrevout.set(prevoutKey(prevout), {
          rowIndex: decoded.length - 1,
          prevout,
        });
      }
    }
  }

  if (unresolvedByPrevout.size > 0) {
    try {
      const resolved = await resolvePrevoutAddresses({
        sdk: params.sdk,
        network: params.network,
        prevouts: Array.from(unresolvedByPrevout.values()).map((v) => v.prevout),
      });
      for (const [key, { rowIndex }] of unresolvedByPrevout.entries()) {
        const addr = resolved.get(key);
        if (!addr) continue;
        const row = decoded[rowIndex];
        if (!row) continue;
        row.actorAddress = addr;
      }
    } catch {
      // Best effort: author stays null when prevout resolution fails.
    }
  }

  const nextCursor: MemoPageCursor | null =
    rows.length > 0
      ? {
          internalId: toBigInt(rows[rows.length - 1].transaction.internal_id),
          outputIndex: Number(rows[rows.length - 1].output_index ?? 0),
        }
      : null;

  return {
    rows: decoded,
    nextCursor,
    sourceRowCount: rows.length,
  };
}
