import {
  queryAuthHead,
  queryTransactionByHash,
  stripChaingraphHexBytes,
} from '../../apis/ChaingraphManager/ChaingraphManager';
import { getChaingraphOutputHex } from './index';

export type ChaingraphOutput = {
  locking_bytecode?: string;
  scriptPubKey?: { hex?: string };
};

export type ChaingraphInput = {
  outpoint_transaction_hash?: string;
  outpoint_index?: number | string;
};

export type ChaingraphTx = {
  hash?: string;
  inputs?: ChaingraphInput[];
  outputs?: ChaingraphOutput[];
};

export const AUTHCHAIN_SEARCH_MAX_DEPTH = 32;

export async function resolveAuthChain(authbase: string): Promise<ChaingraphTx[]> {
  const authHeadData = await queryAuthHead(authbase);
  const headHash = stripChaingraphHexBytes(
    authHeadData?.data?.transaction?.[0]?.authchains?.[0]?.authhead
      ?.identity_output?.[0]?.transaction_hash
  );
  if (!headHash) {
    throw new Error(`No authHead for ${authbase}`);
  }

  const chain: ChaingraphTx[] = [];
  const seen = new Set<string>();
  const queue: Array<{ txid: string; depth: number }> = [
    { txid: headHash, depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (seen.has(current.txid) || current.depth > AUTHCHAIN_SEARCH_MAX_DEPTH) {
      continue;
    }
    seen.add(current.txid);

    const txResp = await queryTransactionByHash(current.txid);
    const tx = txResp?.data?.transaction?.[0] as ChaingraphTx | undefined;
    if (!tx) {
      throw new Error(`Chaingraph missing transaction ${current.txid}`);
    }
    chain.push(tx);

    const previousHashes = (tx.inputs || [])
      .filter((input) => String(input.outpoint_index) === '0')
      .map((input) => stripChaingraphHexBytes(input.outpoint_transaction_hash))
      .filter(Boolean);

    for (const previousHash of previousHashes) {
      if (seen.has(previousHash)) continue;
      queue.push({ txid: previousHash, depth: current.depth + 1 });
    }
  }

  return chain;
}

export function findBcmrOutput(tx: ChaingraphTx): ChaingraphOutput | null {
  return (
    tx.outputs?.find((o) =>
      getChaingraphOutputHex(o).startsWith('6a0442434d52')
    ) || null
  );
}

export function parseBcmrOutput(voutHex: string): { hash: string; uris: string[] } {
  let cursor = voutHex.indexOf('6a0442434d52');
  if (cursor < 0) {
    throw new Error('Not a BCMR OP_RETURN output.');
  }
  cursor += '6a0442434d52'.length;
  const hashPush = voutHex.slice(cursor, cursor + 2);
  if (hashPush !== '20') {
    throw new Error('Invalid BCMR hash push opcode.');
  }
  cursor += 2;
  const hash = voutHex.slice(cursor, cursor + 64);
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error('Invalid BCMR hash payload.');
  }
  cursor += 64;
  const uris: string[] = [];
  while (cursor < voutHex.length) {
    const pushOp = voutHex.slice(cursor, cursor + 2);
    cursor += 2;
    let len = 0;
    if (pushOp === '4c') {
      len = parseInt(voutHex.slice(cursor, cursor + 2), 16) * 2;
      cursor += 2;
    } else if (pushOp === '4d') {
      const lo = parseInt(voutHex.slice(cursor, cursor + 2), 16);
      const hi = parseInt(voutHex.slice(cursor + 2, cursor + 4), 16);
      len = (lo + (hi << 8)) * 2;
      cursor += 4;
    } else if (pushOp === '4e') {
      const b0 = parseInt(voutHex.slice(cursor, cursor + 2), 16);
      const b1 = parseInt(voutHex.slice(cursor + 2, cursor + 4), 16);
      const b2 = parseInt(voutHex.slice(cursor + 4, cursor + 6), 16);
      const b3 = parseInt(voutHex.slice(cursor + 6, cursor + 8), 16);
      len = (b0 + (b1 << 8) + (b2 << 16) + (b3 << 24)) * 2;
      cursor += 8;
    } else {
      len = parseInt(pushOp, 16) * 2;
    }
    const uriHex = voutHex.slice(cursor, cursor + len);
    cursor += len;
    uris.push(Buffer.from(uriHex, 'hex').toString('utf8'));
  }
  return { hash, uris };
}
