// src/utils/utxoHelpers.ts

export const serializeContractFunctionInputs = (
  inputs: { [key: string]: any } | undefined
): string | null => {
  return inputs ? JSON.stringify(inputs) : null;
};

export const deserializeContractFunctionInputs = (
  inputs: string | null
): { [key: string]: any } | undefined => {
  return inputs ? JSON.parse(inputs) : undefined;
};
