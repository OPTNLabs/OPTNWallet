import { cashAddressToLockingBytecode, Transaction } from '@bitauth/libauth'

export function addressToLockScript(address: string): Uint8Array {
    const result = cashAddressToLockingBytecode(address);
  
    if (typeof result === 'string') throw new Error(result);
  
    return result.bytecode;
}
export interface GenerateUnlockingBytecodeOptions {
    transaction: Transaction;
    sourceOutputs: LibauthOutput[];
    inputIndex: number;
}
  
export interface Unlocker {
    generateLockingBytecode: () => Uint8Array;
    generateUnlockingBytecode: (options: GenerateUnlockingBytecodeOptions) => Uint8Array;
}

export interface LibauthOutput {
    lockingBytecode: Uint8Array;
    valueSatoshis: bigint;
    token?: LibauthTokenDetails;
  }