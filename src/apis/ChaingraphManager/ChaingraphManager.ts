// src/apis/ChaingraphManager/ChaingraphManager.ts

const chaingraphUrl = 'https://gql.chaingraph.pat.mn/v1/graphql';

export interface GraphQLResponse<T = any> {
  data?: T;
  errors?: any;
}

async function queryChainGraph<T = any>(
  queryReq: string
): Promise<GraphQLResponse<T>> {
  const jsonObj = {
    operationName: null,
    variables: {},
    query: queryReq,
  };

  try {
    const response = await fetch(chaingraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonObj),
    });

    return (await response.json()) as GraphQLResponse<T>;
  } catch (error) {
    console.error('Error querying ChainGraph:', error);
    throw new Error('Failed to query ChainGraph');
  }
}

function normHex(x: string): string {
  return String(x ?? '')
    .trim()
    .toLowerCase()
    .replace(/^0x/i, '')
    .replace(/^\\x/i, '');
}

export async function queryTotalSupplyFT(
  tokenId: string
): Promise<GraphQLResponse> {
  const tid = normHex(tokenId);
  const queryReqTotalSupply = `query {
    transaction(
      where: {
        inputs: {
          outpoint_transaction_hash: { _eq: "\\\\x${tid}" }
          outpoint_index: { _eq: 0 }
        }
      }
    ) {
      outputs(where: { token_category: { _eq: "\\\\x${tid}" } }) {
        fungible_token_amount
      }
    }
  }`;
  return queryChainGraph(queryReqTotalSupply);
}

export async function queryActiveMinting(
  tokenId: string
): Promise<GraphQLResponse> {
  const tid = normHex(tokenId);
  const queryReqActiveMinting = `query {
    output(
      where: {
        token_category: { _eq: "\\\\x${tid}" }
        _and: { nonfungible_token_capability: { _eq: "minting" } }
        _not: { spent_by: {} }
      }
    ) {
      locking_bytecode
    }
  }`;
  return queryChainGraph(queryReqActiveMinting);
}

export async function querySupplyNFTs(
  tokenId: string,
  offset: number = 0
): Promise<GraphQLResponse> {
  const tid = normHex(tokenId);
  const queryReqTotalSupply = `query {
    output(
      offset: ${offset}
      where: {
        token_category: { _eq: "\\\\x${tid}" }
        _and: [ { nonfungible_token_capability: { _eq: "none" } } ]
        _not: { spent_by: {} }
      }
    ) {
      locking_bytecode
    }
  }`;
  return queryChainGraph(queryReqTotalSupply);
}

/**
 * Existing helper (may be useful for other flows).
 * NOTE: This "authchains" shape depends on the Chaingraph instance/schema.
 */
export async function queryAuthHead(tokenId: string): Promise<GraphQLResponse> {
  const tid = normHex(tokenId);
  const queryReqAuthHead = `query {
    transaction(
      where: {
        hash: { _eq: "\\\\x${tid}" }
      }
    ) {
      hash
      authchains {
        authhead {
          identity_output {
            transaction_hash
          }
        }
      }
    }
  }`;
  return queryChainGraph(queryReqAuthHead);
}

export async function queryTransactionByHash(
  txid: string
): Promise<GraphQLResponse> {
  const t = normHex(txid);
  const query = `query {
    transaction(where: { hash: { _eq: "\\\\x${t}" } }) {
      outputs {
        scriptPubKey { hex }
      }
    }
  }`;
  return queryChainGraph(query);
}

/**
 * The one we use for AuthHead discovery:
 * Find unspent outputs at a locking_bytecode and with token_category == tokenId.
 *
 * Returns outpoints + value + token fields.
 */
export async function queryUnspentOutputsByLockingBytecode(
  lockingBytecodeHex: string,
  tokenId: string
): Promise<
  GraphQLResponse<{
    output: Array<{
      transaction_hash: string; // "\\x..."
      output_index: number;
      value_satoshis: number;

      token_category: string | null;
      fungible_token_amount: string | number | null;

      nonfungible_token_capability: 'none' | 'mutable' | 'minting' | null;
      nonfungible_token_commitment: string | null;

      locking_bytecode?: string;
    }>;
  }>
> {
  const lb = normHex(lockingBytecodeHex);
  const tid = normHex(tokenId);

  const query = `query {
    output(
      where: {
        locking_bytecode: { _eq: "\\\\x${lb}" }
        token_category: { _eq: "\\\\x${tid}" }
        _not: { spent_by: {} }
      }
      order_by: { value_satoshis: desc }
    ) {
      transaction_hash
      output_index
      value_satoshis

      token_category
      fungible_token_amount
      nonfungible_token_capability
      nonfungible_token_commitment
      locking_bytecode
    }
  }`;

  return queryChainGraph(query);
}

/**
 * Utility for callers to strip Chaingraph byte strings: "\\x<hex>" -> "<hex>"
 */
export function stripChaingraphHexBytes(x: any): string {
  if (!x) return '';
  return String(x)
    .trim()
    .toLowerCase()
    .replace(/^\\x/i, '')
    .replace(/^0x/i, '');
}
