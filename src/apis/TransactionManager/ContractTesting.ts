// @ts-ignore
import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
} from "cashscript";
import { UTXOs } from "../types";
import { Utxo, Contract } from "cashscript";
import { hash160 } from "@cashscript/utils";
import UTXOManager from "../UTXOManager/UTXOManager";
import { Decimal } from "decimal.js";
import DatabaseService from "../DatabaseManager/DatabaseService";
import P2PKH from "./p2pkh.json" assert { type: "json" };
const DUST_LIMIT = 546;

export default function TransactionBuilders2() {
  const provider = new ElectrumNetworkProvider("chipnet");
  const ManageUTXOs = UTXOManager();
  const dbService = DatabaseService();

  async function createTransaction(
    wallet_id: number,
    recipients: Array<{ address: string; amount: number }>,
    fee: number = DUST_LIMIT / 3
  ): Promise<any> {
    const sendTotal = recipients
      .reduce((sum, cur) => sum.plus(cur.amount), new Decimal(0))
      .toNumber();
    const UTXO_inputs: UTXOs[] | null = await (
      await ManageUTXOs
    ).fetchUTXOs(sendTotal, fee, "BCH", wallet_id);
    if (UTXO_inputs == null) {
      console.log("No utxo inputs fetched from wallet");
      return null;
    }

    const convertedUTXOs: Utxo[] = UTXO_inputs.map((utxo) => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      satoshis: BigInt(utxo.amount),
    }));

    const privateKeys: Uint8Array[] = UTXO_inputs.map(
      (utxo) => utxo.private_key
    );
    const transactionBuilder = new TransactionBuilder({ provider });

    const addressType = "p2sh32";
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      return null;
    }
    console.log("converted utxos", convertedUTXOs);
    convertedUTXOs.forEach(async (utxo, index) => {
      const privateKey = privateKeys[index];
      console.log("private key:", privateKey);

      const getAllKeysQuery = db.prepare("SELECT * FROM keys;");
      console.log("All keys in the keys table:");
      while (getAllKeysQuery.step()) {
        const row = getAllKeysQuery.getAsObject();
        console.log("row", row);
      }
      getAllKeysQuery.free();

      const getIdQuery = db.prepare(
        "SELECT public_key FROM keys WHERE address = ?;"
      );
      getIdQuery.bind([UTXO_inputs[index].address]);

      let publicKeyArray: Uint8Array | null = null;
      while (getIdQuery.step()) {
        const row = getIdQuery.getAsObject();
        console.log("row", row);

        if (row.public_key) {
          publicKeyArray = new Uint8Array(Object.values(row.public_key));
          break;
        }
      }

      getIdQuery.free();
      console.log("Public key:", publicKeyArray);
      if (!publicKeyArray) {
        console.error(`No public key found for private key at index ${index}`);
        return;
      }
      console.log(
        "Checking private key, public inputs:",
        UTXO_inputs[index].private_key
      );

      const hash_public_key = hash160(publicKeyArray);

      const contract = new Contract(P2PKH, [hash_public_key], {
        provider: provider,
        addressType: "p2sh32",
      });
      console.log("CONTRACT ADDRESS: ", contract.address)

      const contractUtxos = await contract.getUtxos();
      const { withToken: tokenUTXO, withoutToken: regularUTXO } =
        separateUtxos(contractUtxos);
      const {
        collectedObjects: contractSpendUTXOs,
        totalSatoshis: satoshiAmount,
      } = collectUTXOs(regularUTXO, 50000);
      const unlockableContractUtxos = contractSpendUTXOs.map((item) => ({
        ...item,
        unlocker: contract.unlock.spend(
          publicKeyArray,
          new SignatureTemplate(privateKey)
        ),
      }));

      const contractTxOutputs = [
        {
          to: contract.address,
          amount: satoshiAmount - BigInt(500),
        },
      ];
      transactionBuilder.addInputs(unlockableContractUtxos);

      transactionBuilder.addOutputs(contractTxOutputs);

      console.log(transactionBuilder);

      // Send the transaction
      const sendTx = await transactionBuilder.send();

      // Log the transaction details
      console.log(`Transaction detail: `, sendTx.txid);

      console.log("get address", contract.address);
      console.log("utxo being inputted", utxo);
      console.log("contract", contract);

      // transactionBuilder.addInput(utxo, contract.unlock.spend(publicKeyArray, new SignatureTemplate(privateKey)));
    });

    // console.log(recipients);
    // recipients.forEach((recipient) => {
    //   transactionBuilder.addOutput({
    //     to: recipient.address,
    //     amount: BigInt(recipient.amount),
    //   });
    // });

    // transactionBuilder.setMaxFee(BigInt(10000000));
    // console.log("trnsaction builder", transactionBuilder);
    // const txDetails = await transactionBuilder.send();
    // console.log("Transaction details:", txDetails);

    // const txHex = transactionBuilder.build();
    // console.log("Transaction hex:", txHex);

    // return txDetails;
  }

  const separateUtxos = (arr: any) => {
    const withToken = [];
    const withoutToken = [];

    arr.forEach((item) => {
      if (item.token === undefined) {
        withoutToken.push(item);
      } else {
        withToken.push(item);
      }
    });

    return { withToken, withoutToken };
  };

  const collectUTXOs = (arr: any, requestedAmount: any) => {
    let totalSatoshis = 0n;
    const collectedObjects = [];

    for (const item of arr) {
      collectedObjects.push(item);
      totalSatoshis += item.satoshis;
      if (totalSatoshis >= requestedAmount) {
        return { collectedObjects, totalSatoshis };
      }
    }

    throw new Error(
      "Not enough satoshis in the UTXO set to meet the requested amount"
    );
  };

  return {
    createTransaction,
  };
}
