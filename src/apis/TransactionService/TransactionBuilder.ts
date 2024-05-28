import {
  sha256,
  encodeTransaction,
  generateTransaction,
  hexToBin,
  swapEndianness,
  importAuthenticationTemplate,
  authenticationTemplateP2pkhNonHd,
  authenticationTemplateToCompilerBCH,
} from "@bitauth/libauth";
import { Decimal } from "decimal.js";
import { binToHex } from "../../utils/hex";
import { Buffer } from "buffer";
import { addressToLockingByteCode } from "../../utils/functions/conversions";

const DUST_LIMIT = 546;

export default function Transactions() {
  return {
    buildTransaction,
  };

  async function buildTransaction(
    inputs: Array<{
      height: number;
      tx_hash: string;
      tx_pos: number;
      value: number;
    }>,
    recipients: Array<{ address: string; amount: number }>,
    privateKey: Uint8Array,
    fee: number = DUST_LIMIT / 3,
    depth: number = 0
  ) {
    console.log(privateKey);
    const sendTotal = recipients
      .reduce((sum, cur) => sum.plus(cur.amount), new Decimal(0))
      .toNumber();

    const inputTotal = inputs
      .reduce((sum, cur) => sum.plus(cur.value), new Decimal(0))
      .toNumber();

    let changeTotal = inputTotal - sendTotal - fee;

    const template = importAuthenticationTemplate(
      authenticationTemplateP2pkhNonHd
    );
    if (typeof template === 'string') {
      console.error('Error importing authentication template:', template);
      return null;
    }
    const compiler = authenticationTemplateToCompilerBCH(template);


    const vout = recipients.map((out) => ({
      lockingBytecode: addressToLockingByteCode(out.address),
      valueSatoshis: BigInt(out.amount.toString()),
    }));

    if (changeTotal >= DUST_LIMIT) {
      const changeAddress =
        "bchtest:qr6el0mxumpkwpxx8s6ymegzxns43d4kh5vjyvkg6r";
      vout.push({
        lockingBytecode: addressToLockingByteCode(changeAddress),
        valueSatoshis: BigInt(changeTotal),
      });
    } else {
      fee += changeTotal;
      changeTotal = 0;
    }
    console.log("testing the input", inputs);
    const transactionInputs = inputs.map((input) => ({
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
    }));

    const generatedTx = generateTransaction({
      inputs: transactionInputs,
      outputs: vout,
      locktime: 0,
      version: 2,
    });

    console.log("Generated tx", generatedTx);
    if (generatedTx.success === false) {
      console.log("tx generation failed", generatedTx);
      return null;
    }
    const tx_raw = encodeTransaction(generatedTx.transaction);
    const tx_raw_buffer = Buffer.from(tx_raw);
    const tx_hex = binToHex(tx_raw_buffer);
    const tx_hash = swapEndianness(binToHex(sha256.hash(sha256.hash(tx_raw))));

    const feeTotal = changeTotal >= DUST_LIMIT ? fee : fee + changeTotal;
    const newFee = Math.max(tx_raw.length, feeTotal);

    if (newFee > fee) {
      if (depth < 3) {
        return buildTransaction(
          inputs,
          recipients,
          privateKey,
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

    return {
      txid: tx_hash,
      hex: tx_hex,
    };
  }
}
