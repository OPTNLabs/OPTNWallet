import { cashAddressToLockingBytecode } from '@bitauth/libauth'

export function addressToLockScript(address: string): Uint8Array {
    const result = cashAddressToLockingBytecode(address);
  
    if (typeof result === 'string') throw new Error(result);
  
    return result.bytecode;
}