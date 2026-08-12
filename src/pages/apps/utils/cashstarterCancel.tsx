// @ts-nocheck
import { Contract, Utxo, TransactionBuilder, ElectrumNetworkProvider, Network, Unlocker } from 'cashscript';
import { hexToBin, cashAddressToLockingBytecode, decodeTransaction } from '@bitauth/libauth';
import { AddressCashStarter, AddressTokensCashStarter, MasterCategoryID, AddressTokensCashStarterCancel } from './values'

interface CashStarterCancelParams {
  electrumServer: ElectrumNetworkProvider | undefined;
  contractCashStarter: Contract | undefined;
  contractCashStarterCancel: Contract | undefined;
  campaignID: string;
  usersAddress: string;
  signTransaction: (options: any) => Promise<unknown>;
  setError: (message: string) => void;
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
    const campaignUTXO: Utxo = cashStarterUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.commitment.substring(70,80) === campaignID,
    )!;
    console.log('selected campaignNFT UTXO: ');
    console.log(campaignUTXO);

  //cancelUTXO
    //Get all utxos on cancelContract      
    const cancelUTXOs = await contractCashStarterCancel.getUtxos(); 
    console.log('cancelUTXOs:');
    console.log(cancelUTXOs);

    //Find failMinter minting NFT
    const cancelUTXO: Utxo = cancelUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.capability == 'minting',
    )!;
    console.log('selected cancelNFT UTXO: ');
    console.log(cancelUTXO);

  //userUTXO
    //Get all utxos from usersAddress    
    const userUTXOs = await electrumServer!.getUtxos(usersAddress); 
    console.log('userUTXOs:');
    console.log(userUTXOs);

    //Find user utxo that meets fee requirements
    const userUTXO: Utxo = userUTXOs.find(
      utxo => !utxo.token?.category   //does not have a category set
      && utxo.satoshis >= 1000n
    )!;
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
          amount: cancelUTXO.token?.amount!,  
          category: cancelUTXO.token?.category!,  
          nft: {
            capability: cancelUTXO.token?.nft?.capability!, 
            commitment: cancelUTXO.token?.nft?.commitment!
          }
        },
    })

    if (campaignUTXO.satoshis > 1000n) {
      txDetails.addOutput({
        to: AddressTokensCashStarter,  
        amount: campaignUTXO.satoshis - 1000n,
          token: {
            amount: campaignUTXO.token?.amount!,  
            category: campaignUTXO.token?.category!,  
            nft: {
              capability: 'mutable', 
              commitment: campaignUTXO.token?.nft?.commitment!   
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
  
      decodedTransaction.inputs[2].unlockingBytecode = Uint8Array.from([]);         //reset users signature for input2
      console.log('decodedTransaction: ');
      console.log(decodedTransaction);
  
      // construct new transaction object for SourceOutputs, for stringify & not to mutate current network provider 
      const binTokenCategory = hexToBin(campaignUTXO.token?.category!);
      const cancelBinCommitment = hexToBin(cancelUTXO.token?.nft?.commitment!);
      const campaignBinCommitment = hexToBin(campaignUTXO.token?.nft?.commitment!);
      
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
          amount: cancelUTXO?.token?.amount,
          category: binTokenCategory,
          nft: {
            capability: cancelUTXO.token?.nft?.capability!, 
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
          amount: campaignUTXO?.token?.amount,
          category: binTokenCategory,
          nft: {
            capability: campaignUTXO.token?.nft?.capability!,
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

      const signResult: any = await signTransaction(wcTransactionObj);

      console.log('finished cashstarterFail()');
      return signResult;

    } catch (error) {
      console.log('cashstarterFail(): tx build failed: ' + error);
      setError(`Error canceling: ` + error);
    }
  }
}
  
export default cashstarterCancel;