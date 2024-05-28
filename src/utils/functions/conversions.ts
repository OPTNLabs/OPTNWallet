import {
    cashAddressToLockingBytecode,
    base58AddressToLockingBytecode,
} from '@bitauth/libauth';
import { validateInvoiceString } from '../invoice';

export function addressToLockingByteCode(addr : string) {
    const { isBase58Address, address } = validateInvoiceString(addr);
    const lockingBytecode = isBase58Address
    ? base58AddressToLockingBytecode(address)
    : cashAddressToLockingBytecode(address);

    if (typeof lockingBytecode === "string") {
        throw new Error(lockingBytecode);
    }

    return lockingBytecode.bytecode;
}