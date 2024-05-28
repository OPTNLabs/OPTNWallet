import { Decimal } from "decimal.js";
import { decodeCashAddress, decodeBase58Address } from "@bitauth/libauth";

export function validateInvoiceString(invoice: string) {
    const address = invoice.split("?")[0];
    const amountMatch = invoice.match(/amount=([0-9]*\.?[0-9]{0,8})/);
    const amount = amountMatch === null ? "0" : amountMatch[1];

    const prefixedAddress = address.includes(":")
    ? address
    : `bitcoincash:${address}`;

    const isCashAddress = typeof decodeCashAddress(prefixedAddress) === "object";
    const isBase58Address =
    !isCashAddress && typeof decodeBase58Address(address) === "object";

    const isValid = isCashAddress || isBase58Address;
    const validCashAddress = isCashAddress ? prefixedAddress : address;
    const finalCashAddress = isValid ? validCashAddress : "";

    const query = new Decimal(amount).greaterThan(0) ? `?amount=${amount}` : "";

    return {
        address: finalCashAddress,
        amount,
        query,
        isValid,
        isCashAddress,
        isBase58Address,
    };
}
