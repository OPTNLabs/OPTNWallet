import { Contract, Utxo, TransactionBuilder, ElectrumNetworkProvider, Network, Unlocker } from 'cashscript';
import { hexToBin, cashAddressToLockingBytecode, decodeTransaction } from '@bitauth/libauth';
import { AddressCashStarter, AddressTokensCashStarter, MasterCategoryID, AddressTokensCashStarterCancel } from './values'

interface CashStarterCancelParams {
  electrumServer: ElectrumNetworkProvider | undefined;
  contractCashStarter: Contract | undefined;
  contractCashStarterCancel: Contract | undefined;
  campaignID: string;
  usersAddress: string;
  signTransaction: (options: {
    transaction: unknown;
    sourceOutputs: unknown[];
    broadcast: boolean;
    userPrompt: string;
  }) => Promise<unknown>;
  setError: (message: string) => void;
}

type UtxoToken = NonNullable<Utxo['token']>;
type UtxoTokenWithNft = UtxoToken & { nft: NonNullable<UtxoToken['nft']> };

function requireToken(utxo: Utxo, context: string): UtxoTokenWithNft {
  if (!utxo.token?.nft) {
    throw new Error(`Missing token data for ${context}`);
  }
  return utxo.token as UtxoTokenWithNft;
}

async function cashstarterCancel({ electrumServer, contractCashStarter, contractCashStarterCancel, campaignID, usersAddress, signTransaction, setError }: CashStarterCancelParams) {
  
  if (electrumServer && contractCashStarter && contractCashStarterCancel) {

    //Creating lockingBytecode for contract address
    const cashStarterLockingBytecodeResult = cashAddressToLockingBytecode(AddressCashStarter);
    if (typeof cashStarterLockingBytecodeResult === 'string') {
      throw new Error(`Failed to convert CashAddress to locking bytecode: ${cashStarterLockingBytecodeResult}`);
    }
    //Creating lockingBytecode for contract address
    const userLockingBytecodeResult = cashAddressToLockingBytecode(usersAddress);
    if (typeof userLockingBytecodeResult === 'string') {
      throw new Error(`Failed to convert CashAddress to locking bytecode: ${userLockingBytecodeResult}`);
    }

  //campaignUTXO
    //Get all utxos on cashStarter contract      
    const cashStarterUTXOs = await contractCashStarter.getUtxos(); 
    console.log('cashStarter utxos:');
    console.log(cashStarterUTXOs);

    //Find campaignNFT
    const campaignUTXO = cashStarterUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.commitment.substring(70,80) === campaignID,
    );
    if (!campaignUTXO) {
      throw new Error('Unable to find campaign UTXO for cancel flow');
    }
    console.log('selected campaignNFT UTXO: ');
    console.log(campaignUTXO);

  //cancelUTXO
    //Get all utxos on cancelContract      
    const cancelUTXOs = await contractCashStarterCancel.getUtxos(); 
    console.log('cancelUTXOs:');
    console.log(cancelUTXOs);

    //Find failMinter minting NFT
    const cancelUTXO = cancelUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.capability == 'minting',
    );
    if (!cancelUTXO) {
      throw new Error('Unable to find cancel UTXO for cancel flow');
    }
    console.log('selected cancelNFT UTXO: ');
    console.log(cancelUTXO);

  //userUTXO
    //Get all utxos from usersAddress    
    const userUTXOs = await electrumServer!.getUtxos(usersAddress); 
    console.log('userUTXOs:');
    console.log(userUTXOs);

    //Find user utxo that meets fee requirements
    const userUTXO = userUTXOs.find(
      utxo => !utxo.token?.category   //does not have a category set
      && utxo.satoshis >= 1000n
    );
    if (!userUTXO) {
      throw new Error('Unable to find fee-paying user UTXO for cancel flow');
    }
    console.log('selected userUTXO: ');
    console.log(userUTXO);

    const p2pkhUnlocker: Unlocker = {
      generateLockingBytecode: () => { 
        const result = cashAddressToLockingBytecode(usersAddress);
  
        if (typeof result === 'string') {
          throw new Error(`Failed to convert CashAddress to locking bytecode: ${result}`);
        }
        return result.bytecode;
      },
      generateUnlockingBytecode: () => {          // Return an empty array or a placeholder for the unlocking bytecode (scriptSig)
        return Uint8Array.from([]);
      }
    };

    const provider = new ElectrumNetworkProvider(Network.MAINNET);

    const txDetails = await new TransactionBuilder({ provider })
    .addInput(cancelUTXO, contractCashStarterCancel.unlock.cancel())
    .addInput(campaignUTXO, contractCashStarter.unlock.externalFunction())
    .addInput(userUTXO, p2pkhUnlocker)
    .addOutput({
      to: AddressTokensCashStarterCancel,  
      amount: cancelUTXO.satoshis,
        token: {
          amount: requireToken(cancelUTXO, 'cancelUTXO').amount,
          category: requireToken(cancelUTXO, 'cancelUTXO').category,
          nft: {
            capability: requireToken(cancelUTXO, 'cancelUTXO').nft.capability,
            commitment: requireToken(cancelUTXO, 'cancelUTXO').nft.commitment
          }
        },
    })

    if (campaignUTXO.satoshis > 1000n) {
      txDetails.addOutput({
        to: AddressTokensCashStarter,  
        amount: campaignUTXO.satoshis - 1000n,
          token: {
            amount: requireToken(campaignUTXO, 'campaignUTXO').amount,
            category: requireToken(campaignUTXO, 'campaignUTXO').category,
            nft: {
              capability: 'mutable', 
              commitment: requireToken(campaignUTXO, 'campaignUTXO').nft.commitment
            }
          },
      })
    }

    txDetails.addOutput({
      to: usersAddress,  
      amount: userUTXO.satoshis,
    })

    console.log('transaction pre-build: ');
    console.log(txDetails);

    try {                                                                        
      const rawTransactionHex = await txDetails.build();          // build the transaction we created                          

      const decodedTransaction = decodeTransaction(hexToBin(rawTransactionHex));    //decode the built transaction        
      if (typeof decodedTransaction === "string") {
        alert("No suitable utxos found for minting. Try to consolidate your utxos!");
        throw ("No suitable utxos found for minting. Try to consolidate your utxos!");
      }
  
      const cancelToken = requireToken(cancelUTXO, 'cancelUTXO');
      const campaignToken = requireToken(campaignUTXO, 'campaignUTXO');

      decodedTransaction.inputs[2].unlockingBytecode = Uint8Array.from([]);         //reset users signature for input2
      console.log('decodedTransaction: ');
      console.log(decodedTransaction);

      // construct new transaction object for SourceOutputs, for stringify & not to mutate current network provider 
      const binTokenCategory = hexToBin(campaignToken.category);
      const cancelBinCommitment = hexToBin(cancelToken.nft.commitment);
      const campaignBinCommitment = hexToBin(campaignToken.nft.commitment);
      
      const listSourceOutputs = [{
        ...decodedTransaction.inputs[0],
        lockingBytecode: (cashAddressToLockingBytecode(AddressTokensCashStarterCancel) as { bytecode: Uint8Array }).bytecode,
        valueSatoshis: BigInt(cancelUTXO.satoshis),
        contract: {
          abiFunction: contractCashStarterCancel.artifact.abi, 
          redeemScript: contractCashStarterCancel.redeemScript,
          artifact: contractCashStarterCancel.artifact,
        },
        token: {
          amount: cancelToken.amount,
          category: binTokenCategory,
          nft: {
            capability: cancelToken.nft.capability, 
            commitment: cancelBinCommitment 
          }
        }
      },
      {
        ...decodedTransaction.inputs[1],
        lockingBytecode: (cashAddressToLockingBytecode(AddressTokensCashStarter) as { bytecode: Uint8Array }).bytecode,
        valueSatoshis: BigInt(campaignUTXO.satoshis),
        contract: {
          abiFunction: contractCashStarter.artifact.abi,        
          redeemScript: contractCashStarter.redeemScript,
          artifact: contractCashStarter.artifact,
        },
        token: {
          amount: campaignToken.amount,
          category: binTokenCategory,
          nft: {
            capability: campaignToken.nft.capability,
            commitment: campaignBinCommitment 
          }
        }
      }, {
        ...decodedTransaction.inputs[2],
        lockingBytecode: (cashAddressToLockingBytecode(usersAddress) as { bytecode: Uint8Array }).bytecode,
        valueSatoshis: BigInt(userUTXO.satoshis),
      }];
  
      //create transaction object to give for signing
      const wcTransactionObj = {
        transaction: decodedTransaction,
        sourceOutputs: listSourceOutputs,
        broadcast: false,
        userPrompt: "Cancel Campaign"
      };
      console.log(wcTransactionObj);
  
      console.log('Sent cancel to your wallet for approval');
      setError(`Sent cancel to your wallet for approval`);

      const signResult = await signTransaction(wcTransactionObj);

      console.log('finished cashstarterFail()');
      return signResult;

    } catch (error) {
      console.log('cashstarterFail(): tx build failed: ' + error);
      setError(`Error canceling: ` + error);
    }
  }
}
  
export default cashstarterCancel;
