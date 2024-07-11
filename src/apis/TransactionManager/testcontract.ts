import {
  Contract,
  ElectrumNetworkProvider,
  TransactionBuilder,
  Network,
  SignatureTemplate,
} from 'cashscript';
import { compileFile } from 'cashc';
import { alicePkh, alicePriv, alicePub } from './common.js';
import { URL } from 'url';

async function run() {
  const artifact = compileFile(new URL('p2pkh.cash', import.meta.url));

  const provider = new ElectrumNetworkProvider(Network.CHIPNET);

  const contract = new Contract(artifact, [alicePkh], {
    provider: provider,
    addressType: 'p2sh32',
  });

  const repeatTransaction = 1;

  for (let i = 0; i < repeatTransaction; i++) {
    try {
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
          alicePub,
          new SignatureTemplate(alicePriv)
        ),
      }));

      const contractTxOutputs = [
        {
          to: contract.address,
          amount: satoshiAmount - BigInt(500),
        },
      ];

      const transactionBuilder = new TransactionBuilder({ provider });

      transactionBuilder.addInputs(unlockableContractUtxos);

      transactionBuilder.addOutputs(contractTxOutputs);

      console.log(transactionBuilder);

      // Send the transaction
      const sendTx = await transactionBuilder.send();

      // Log the transaction details
      console.log(`Transaction ${i + 1} detail: `, sendTx.txid);
    } catch (error) {
      console.error(`Error in transaction ${i + 1}:`, error);
      break; // Optionally break the loop if an error occurs
    }
  }
}

const separateUtxos = (arr) => {
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

const collectUTXOs = (arr, requestedAmount) => {
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

run();
