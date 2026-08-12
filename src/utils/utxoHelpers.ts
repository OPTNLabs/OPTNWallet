export const serializeContractFunctionInputs = (
  inputs: { [key: string]: any } | undefined
): string | null => {
  const serialized = inputs ? JSON.stringify(inputs) : null;
  // console.log('Serializing contractFunctionInputs:', inputs, '->', serialized);
  return serialized;
};

export const deserializeContractFunctionInputs = (
  inputs: string | null
): { [key: string]: any } | undefined => {
  const deserialized = inputs ? JSON.parse(inputs) : undefined;
  // console.log(
  //   'Deserializing contractFunctionInputs:',
  //   inputs,
  //   '->',
  //   deserialized
  // );
  return deserialized;
};
