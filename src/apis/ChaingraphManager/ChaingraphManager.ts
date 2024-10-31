import fetch from 'node-fetch';

const chaingraphUrl = 'https://gql.chaingraph.pat.mn/v1/graphql';

interface GraphQLResponse {
  data?: any;
  errors?: any;
}

async function queryChainGraph(queryReq: string): Promise<GraphQLResponse> {
  const jsonObj = {
    operationName: null,
    variables: {},
    query: queryReq,
  };

  try {
    const response = await fetch(chaingraphUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jsonObj),
    });

    return await response.json();
  } catch (error) {
    console.error('Error querying ChainGraph:', error);
    throw new Error('Failed to query ChainGraph');
  }
}

export async function queryTotalSupplyFT(tokenId: string): Promise<any> {
  const queryReqTotalSupply = `query {
    transaction(
      where: {
        inputs: {
          outpoint_transaction_hash: { _eq: "\\\\x${tokenId}" }
          outpoint_index: { _eq: 0 }
        }
      }
    ) {
      outputs(where: { token_category: { _eq: "\\\\x${tokenId}" } }) {
        fungible_token_amount
      }
    }
  }`;
  return await queryChainGraph(queryReqTotalSupply);
}

export async function queryActiveMinting(tokenId: string): Promise<any> {
  const queryReqActiveMinting = `query {
    output(
      where: {
        token_category: { _eq: "\\\\x${tokenId}" }
        _and: { nonfungible_token_capability: { _eq: "minting" } }
        _not: { spent_by: {} }
      }
    ) {
      locking_bytecode
    }
  }`;
  return await queryChainGraph(queryReqActiveMinting);
}

export async function querySupplyNFTs(
  tokenId: string,
  offset: number = 0
): Promise<any> {
  const queryReqTotalSupply = `query {
    output(
      offset: ${offset}
      where: {
        token_category: {
          _eq: "\\\\x${tokenId}"
        }
        _and: [
          { nonfungible_token_capability: { _eq: "none" } }
        ]
        _not: { spent_by: {} }
      }
    ) {
      locking_bytecode
    }
  }`;
  return await queryChainGraph(queryReqTotalSupply);
}

export async function queryAuthHead(tokenId: string): Promise<any> {
  const queryReqAuthHead = `query {
    transaction(
      where: {
        hash: {
          _eq: "\\\\x${tokenId}"
        }
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
  return await queryChainGraph(queryReqAuthHead);
}
