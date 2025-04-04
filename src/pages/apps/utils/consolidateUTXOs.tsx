// @ts-nocheck
import { Unlocker, TransactionBuilder, ElectrumNetworkProvider, Network } from 'cashscript';
import { hexToBin, cashAddressToLockingBytecode, decodeTransaction } from '@bitauth/libauth';

interface ConsolidateUTXOsParams {
    electrumServer: ElectrumNetworkProvider | undefined;
    usersAddress: string;
    transactionBuilder: TransactionBuilder | undefined;
    signTransaction: (options: any) => Promise<unknown>;
    setError: (message: string) => void;
  }

async function consolidateUtxos({ electrumServer, usersAddress, transactionBuilder, signTransaction, setError }: ConsolidateUTXOsParams) {
    const utxos = await electrumServer!.getUtxos(usersAddress);     // 1. Get UTXOs from user's address
    console.log('user utxos:');
    console.log(utxos);    

    const untokenizedUtxos = utxos.filter(utxo => !utxo.token);     // 2. Filter out UTXOs that are already configured with a token 
    console.log('untokenzied utxos:');
    console.log(untokenizedUtxos); 

    const sumSatoshis = untokenizedUtxos.reduce((accumulator, utxo) => {  //add up satoshis from all the inputs
        return accumulator + utxo.satoshis;
    }, 0n); // Initial value 0 (BigInt)
    console.log('sum sats: ');
    console.log(sumSatoshis);
    
    const txFee = BigInt((untokenizedUtxos.length * 150) + 34 + 10);      //miner transaction fee: # inputs * 150bytes + 34bytes (1 output) + 10bytes (overhead)

    if (txFee >= sumSatoshis + 546n) {
        console.log("Error: Fee to consolidate higher than the total satoshis being combined.")
        setError('Error: Fee to consolidate higher than the total satoshis being combined.')
        return;
    }

    //##  Build transaction       
    const p2pkhUnlocker: Unlocker = {
        generateLockingBytecode: () => {
            const result = cashAddressToLockingBytecode(usersAddress);
            if (typeof result === 'string') {
                throw new Error(`Failed to convert CashAddress to locking bytecode: ${result}`);
            }
            return result.bytecode;
        },
        generateUnlockingBytecode: () => {
            return Uint8Array.from([]); // Placeholder for the unlocking bytecode
        }
    };

    const provider = new ElectrumNetworkProvider(Network.MAINNET);
    const txDetails = await new TransactionBuilder({ provider })
        .addInputs(untokenizedUtxos, p2pkhUnlocker)
        .addOutput({
        to: usersAddress, 
        amount: sumSatoshis - txFee,
        })

    try {                                                                         
        const rawTransactionHex = await txDetails!.build();                   // build the transaction we created                    
        const decodedTransaction = decodeTransaction(hexToBin(rawTransactionHex));    //decode the built transaction        
        if (typeof decodedTransaction === "string") {
            alert("No suitable utxos found for minting. Try to consolidate your utxos!");
            throw ("No suitable utxos found for minting. Try to consolidate your utxos!");
        }

        for (let i = 0; i < decodedTransaction.inputs.length; i++) {                    //loop through all inputs in transaction
            decodedTransaction.inputs[i].unlockingBytecode = Uint8Array.from([]);         //reset users signature for the input
        }

        // construct new transaction object for SourceOutputs, for stringify & not to mutate current network provider 
        const listSourceOutputs = decodedTransaction.inputs.map((input, index) => {
            const originalUtxo = untokenizedUtxos[index];     // Find the original UTXO that corresponds to the current input
            return {
                ...input,
                lockingBytecode: (cashAddressToLockingBytecode(usersAddress) as { bytecode: Uint8Array }).bytecode,
                valueSatoshis: BigInt(originalUtxo.satoshis),
            };
        });

        //create transaction object to give for signing
        const wcTransactionObj = {
            transaction: decodedTransaction,
            sourceOutputs: listSourceOutputs,
            broadcast: false,
            userPrompt: "Consolidate UTXOs"
        };
        const signResult: any = await signTransaction(wcTransactionObj);
        return signResult;

    } catch (error) {
        console.log('tx build failed: ' + error);
    }
};
  
  export default consolidateUtxos;