import {
  sha256,
  encodeTransaction,
  generateTransaction,
  hexToBin,
  swapEndianness,
  cashAddressToLockingBytecode,
  base58AddressToLockingBytecode,
  importAuthenticationTemplate,
  authenticationTemplateP2pkhNonHd,
  authenticationTemplateToCompilerBCH,
} from "@bitauth/libauth";
import { Decimal } from "decimal.js";
import { binToHex } from "../../utils/hex";
import { validateInvoiceString } from "../../utils/invoice";
const DUST_LIMIT = 546;

export default function Transactions() {
  return {
    buildTransaction,
  };
  function addressToLockingByteCode(addr) {
    const { isBase58Address, address } = validateInvoiceString(addr);
    const lockingBytecode = isBase58Address
      ? base58AddressToLockingBytecode(address)
      : cashAddressToLockingBytecode(address);

    if (typeof lockingBytecode === "string") {
      throw new Error(lockingBytecode);
    }

    return lockingBytecode.bytecode;
  }

  async function buildTransaction(
    inputs,
    recipients: Array<{ address: string; amount: number }>,
    privateKey : Uint8Array,
    fee: number = DUST_LIMIT / 3,
    depth: number = 0
  ) {
    const sendTotal = recipients
      .reduce((sum, cur) => sum.plus(cur.amount), new Decimal(0))
      .toNumber();
    let changeTotal = input.value - sendTotal - fee;
    const template = importAuthenticationTemplate(
      authenticationTemplateP2pkhNonHd
    );
    const compiler = authenticationTemplateToCompilerBCH(template);

    const vout = recipients.map((out) => ({
      lockingBytecode: addressToLockingByteCode(out.address),
      valueSatoshis: BigInt(out.amount.toString()),
    }));
    // Public Key: bchtest:qr6el0mxumpkwpxx8s6ymegzxns43d4kh5vjyvkg6r
    // Address: bchtest:qz82a87a7gef965jcq3pm49wkrrvfyafj57ugjd8fz
    // Private Key: 6220238151031251852199226221661521991673910242333901041651451962011162146764231193
    if (changeTotal >= DUST_LIMIT) {
      const changeAddress =
        "bchtest:qr6el0mxumpkwpxx8s6ymegzxns43d4kh5vjyvkg6r";
      vout.push({
        lockingBytecode: addressToLockingByteCode(changeAddress),
        valueSatoshis: BigInt(changeTotal),
      });
    }

    const transactionInput = [
      {
        outpointTransactionHash: hexToBin(input.tx_hash),
        outpointIndex: input.tx_pos,
        sequenceNumber: 0,
        unlockingBytecode: {
          compiler,
          script: "unlock",
          valueSatoshis: BigInt(input.value),
          data: {
            keys: {
              privateKeys: {
                key: privateKey,
              },
            },
          },
        },
      },
    ];

    const generatedTx = generateTransaction({
      inputs: transactionInput,
      outputs: vout,
      locktime: 0,
      version: 2,
    });
    console.log("generated tx", generatedTx);
    const tx_raw = encodeTransaction(generatedTx.transaction);
    const tx_hex = binToHex(tx_raw);
    const tx_hash = swapEndianness(binToHex(sha256.hash(sha256.hash(tx_raw))));

    const feeTotal = changeTotal >= DUST_LIMIT ? fee : fee + changeTotal;
    const newFee = Math.max(tx_raw.length, feeTotal);

    if (newFee > fee) {
      if (depth < 3) {
        return buildTransaction(
          input,
          [
            {
              address: "bchtest:qpeu8h6p5r8kvlplaaz79jcq562qxyv8v5v0s4ajp6",
              amount: 2000,
            },
            {
              address: "bchtest:qz82a87a7gef965jcq3pm49wkrrvfyafj57ugjd8fz",
              amount: 2000,
            },
          ],
          newFee,
          depth + 1
        );
      } else {
        console.error("Maximum depth reached without resolving fee issues.");
        return null;
      }
    }

    console.log(`Final Transaction Hash: ${tx_hash}`);
    console.log(`Final Transaction Hex: ${tx_hex}`);

    // If fee adjustments can't make it smaller, proceed with the transaction
    return {
      txid: tx_hash,
      hex: tx_hex,
    };
  }
}
