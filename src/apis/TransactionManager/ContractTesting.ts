// @ts-ignore
import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
} from 'cashscript';
import { UTXOs } from '../types';
import { Utxo, Contract } from 'cashscript';
// import { hash160 } from "@cashscript/utils";
import UTXOManager from '../UTXOManager/UTXOManager';
// import { Decimal } from "decimal.js";
import DatabaseService from '../DatabaseManager/DatabaseService';
import TransferWithTimeout from './transfer_with_timeout.json';
// const DUST_LIMIT = 546;

export default function TransactionBuilders2() {
  const provider = new ElectrumNetworkProvider('chipnet');
  const ManageUTXOs = UTXOManager();
  const dbService = DatabaseService();

  async function createTransaction(
    wallet_id: number,
    recipients: Array<{ address: string; amount: number }>
    // fee: number = DUST_LIMIT / 3
  ): Promise<any> {
    // const sendTotal = recipients
    //   .reduce((sum, cur) => sum.plus(cur.amount), new Decimal(0))
    //   .toNumber();
    const UTXO_inputs: UTXOs[] | null = await (
      await ManageUTXOs
    ).fetchUTXOs(wallet_id);
    if (UTXO_inputs == null) {
      console.log('No utxo inputs fetched from wallet');
      return null;
    }
    console.log(recipients);

    const convertedUTXOs: Utxo[] = UTXO_inputs.map((utxo) => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      satoshis: BigInt(utxo.amount),
    }));

    const privateKeys: Uint8Array[] = UTXO_inputs.map(
      (utxo) => utxo.private_key
    );
    const transactionBuilder = new TransactionBuilder({ provider });

    const addressType = 'p2sh32';
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      return null;
    }
    console.log('converted utxos', convertedUTXOs);
    convertedUTXOs.forEach(async (utxo, index) => {
      const privateKey = privateKeys[index];
      console.log('private key:', privateKey);

      const getAllKeysQuery = db.prepare('SELECT * FROM keys;');
      console.log('All keys in the keys table:');
      while (getAllKeysQuery.step()) {
        const row = getAllKeysQuery.getAsObject();
        console.log('row', row);
      }
      getAllKeysQuery.free();

      const getIdQuery = db.prepare(
        'SELECT public_key FROM keys WHERE address = ?;'
      );
      getIdQuery.bind([UTXO_inputs[index].address]);

      let publicKeyArray: Uint8Array | null = null;
      while (getIdQuery.step()) {
        const row = getIdQuery.getAsObject();
        console.log('row', row);

        if (row.public_key) {
          publicKeyArray = new Uint8Array(Object.values(row.public_key));
          break;
        }
      }

      getIdQuery.free();
      console.log('Public key:', publicKeyArray);
      if (!publicKeyArray) {
        console.error(`No public key found for private key at index ${index}`);
        return;
      }
      console.log(
        'Checking private key, public inputs:',
        UTXO_inputs[index].private_key
      );

      const recipient_public_key = hexStringToUint8Array(
        '038b8af9abba08a7c7b0046b4d75fa5f4219664d1a187582c3db6300394deee6bf'
      );
      console.log('recipient_public_key', recipient_public_key);
      const contract = new Contract(
        TransferWithTimeout,
        [publicKeyArray, recipient_public_key, BigInt(1)],
        {
          provider: provider,
          addressType: addressType,
        }
      );
      console.log('CONTRACT ADDRESS: ', contract.address);

      const contractUtxos = await contract.getUtxos();
      console.log('contract utxos', contractUtxos);
      const { withToken: tokenUTXO, withoutToken: regularUTXO } =
        separateUtxos(contractUtxos);
      console.log(tokenUTXO);
      const {
        collectedObjects: contractSpendUTXOs,
        totalSatoshis: satoshiAmount,
      } = collectUTXOs(regularUTXO, 50000);

      // const recipientSig = hexStringToUint8Array("5a0aff42d8bda4e3c217dc50d7cabcd0ea614489e282458e023ddfdb95c1dfdc");

      const unlockableContractUtxos = contractSpendUTXOs.map((item) => ({
        ...item,
        unlocker: contract.unlock.timeout(new SignatureTemplate(privateKey)),
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

      // Log the transaction detailsh
      console.log(`Transaction detail: `, sendTx.txid);

      console.log('get address', contract.address);
      console.log('utxo being inputted', utxo);
      console.log('contract', contract);

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
  function hexStringToUint8Array(hexString: string): Uint8Array {
    if (hexString.length % 2 !== 0) {
      throw new Error('Hex string must have an even length');
    }
    const uint8Array = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      uint8Array[i / 2] = parseInt(hexString.substr(i, 2), 16);
    }
    return uint8Array;
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
      'Not enough satoshis in the UTXO set to meet the requested amount'
    );
  };

  return {
    createTransaction,
  };
}
