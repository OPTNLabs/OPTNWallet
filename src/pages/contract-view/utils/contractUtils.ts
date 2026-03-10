import parseInputValue from '../../../utils/parseInputValue';

type ContractArg = {
  name: string;
  type: string;
};

export function toBigIntAmount(
  amount: number | string | bigint | undefined
): bigint {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount === 'number') return BigInt(amount);
  if (typeof amount === 'string' && amount.trim()) return BigInt(amount);
  return 0n;
}

export function validateConstructorArgsComplete(
  constructorArgs: ContractArg[],
  inputValues: Record<string, string>
): { valid: boolean; errorMessage?: string } {
  for (const arg of constructorArgs) {
    const value = inputValues[arg.name];
    if (value === undefined || value === null || value.toString().trim() === '') {
      return {
        valid: false,
        errorMessage: `Please provide a value for "${arg.name}" (${arg.type}).`,
      };
    }
  }
  return { valid: true };
}

export function parseConstructorArgs(
  constructorArgs: ContractArg[],
  inputValues: Record<string, string>
): unknown[] {
  return constructorArgs.map((arg) =>
    parseInputValue(inputValues[arg.name], arg.type)
  );
}
