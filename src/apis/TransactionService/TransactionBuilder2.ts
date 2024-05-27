import { ElectrumNetworkProvider, TransactionBuilder, Network, SignatureTemplate, Contract } from 'cashscript';


const aliceTemplate = "";
const aliceAddress = "bchtest:qztkzxwuh97tv5nd0sg6nflp4r8unz83gvqvzdj3fs"
const bobAddress = "bchtest:qznwqlqtzgqkxpt6gp92da2peprj3202s53trwdn7t"
const tokenCategory = "BCH"

const provider = new ElectrumNetworkProvider(Network.CHIPNET);

const transactionBuilder = new TransactionBuilder({ provider });

(async () => {
  const contract = new Contract(f, s);
  const contractUtxos = await contract.getUtxos();
  const aliceUtxos = await provider.getUtxos(aliceAddress);

  transactionBuilder.addInput(contractUtxos[0], contract.unlock.spend(aliceTemplate, 1000n));
  // need to fix unlocker
  transactionBuilder.addInput(aliceUtxos[0], new SignatureTemplate(aliceTemplate));

  transactionBuilder.addOutput({
    to: bobAddress,
    amount: 100_000n,
    token: {
      amount: 1000n,
      category: tokenCategory,
    }
  });

  transactionBuilder.addOutputs([
    { to: aliceAddress, amount: 50_000n },
    { to: bobAddress, amount: 50_000n },
  ]);

  transactionBuilder.addOpReturnOutput(['0x6d02', 'Hello World!']);

  transactionBuilder.setMaxFee(2000n);

  const txHex = transactionBuilder.build();
  console.log('Transaction Hex:', txHex);

  const txDetails = await transactionBuilder.send();
  console.log('transaction details:', txDetails);
})
().catch(console.error);
