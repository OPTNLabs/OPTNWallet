import { parseJsonOr, reviveUnlockFunctions } from './helpers';
import type {
  AbiFunction,
  ContractArtifact,
  ContractInstanceRow,
  ContractInstanceUtxo,
  SqlRow,
} from './types';

export function parseContractInstanceRow(row: SqlRow): ContractInstanceRow {
  const contractInstance = {
    ...row,
    balance: BigInt((row.balance as string | number | bigint) || 0),
    utxos:
      typeof row.utxos === 'string'
        ? parseJsonOr<Array<Record<string, unknown>>>(row.utxos, []).map(
            (utxo): ContractInstanceUtxo => ({
              ...utxo,
              tx_hash: String(utxo.tx_hash ?? ''),
              tx_pos: Number(utxo.tx_pos ?? 0),
              height: Number(utxo.height ?? 0),
              amount: BigInt(
                (utxo.amount as string | number | bigint | undefined) || 0
              ),
              token: utxo.token,
              prefix: typeof utxo.prefix === 'string' ? utxo.prefix : undefined,
              contractFunction:
                typeof utxo.contractFunction === 'string'
                  ? utxo.contractFunction
                  : undefined,
              contractFunctionInputs: utxo.contractFunctionInputs
                ? parseJsonOr<Record<string, unknown>>(
                    utxo.contractFunctionInputs,
                    {}
                  )
                : undefined,
            })
          )
        : [],
    artifact:
      typeof row.artifact === 'string'
        ? parseJsonOr<ContractArtifact>(row.artifact, {} as ContractArtifact)
        : ({} as ContractArtifact),
    abi:
      typeof row.abi === 'string'
        ? parseJsonOr<AbiFunction[]>(row.abi, [])
        : [],
    redeemScript:
      typeof row.redeemScript === 'string'
        ? parseJsonOr<unknown>(row.redeemScript, null)
        : null,
    unlock:
      typeof row.unlock === 'string'
        ? parseJsonOr<Record<string, string>>(row.unlock, {})
        : null,
    id: Number(row.id ?? 0),
    contract_name: String(row.contract_name ?? ''),
    address: String(row.address ?? ''),
    token_address: String(row.token_address ?? ''),
    updated_at: row.updated_at,
  };

  if (contractInstance.unlock) {
    contractInstance.unlock = reviveUnlockFunctions(contractInstance.unlock);
  }

  return contractInstance as ContractInstanceRow;
}
