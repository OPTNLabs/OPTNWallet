// @ts-nocheck
import { Contract, Utxo, TransactionBuilder, ElectrumNetworkProvider, Network } from 'cashscript';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import { AddressCashStarter, AddressTokensCashStarter, MasterCategoryID, AddressTokensCashStarterStop } from './values'

interface CashStarterFailParams {
  electrumServer: ElectrumNetworkProvider | undefined;
  contractCashStarter: Contract | undefined;
  contractCashStarterStop: Contract | undefined;
  campaignID: string;
}

async function cashstarterStop({ electrumServer, contractCashStarter, contractCashStarterStop, campaignID }: CashStarterFailParams) {
  
  if (electrumServer && contractCashStarter && contractCashStarterStop) {

    const blockHeight = await electrumServer.getBlockHeight();

    //Creating lockingBytecode for contract address
    const cashStarterLockingBytecodeResult = cashAddressToLockingBytecode(AddressCashStarter);
    if (typeof cashStarterLockingBytecodeResult === 'string') {
      throw new Error(`Failed to convert CashAddress to locking bytecode: ${cashStarterLockingBytecodeResult}`);
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

  //failMinterUTXO
    //Get all utxos on failMinter contract      
    const failMinterUTXOs = await contractCashStarterStop.getUtxos(); 
    console.log('failMinter utxos:');
    console.log(failMinterUTXOs);

    //Find failMinter minting NFT
    const failMinterUTXO: Utxo = failMinterUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.capability == 'minting',
    )!; //'!' assumes will always be found
    console.log('selected failMinterNFT UTXO: ');
    console.log(failMinterUTXO);

    const provider = new ElectrumNetworkProvider(Network.MAINNET);

    let txDetails;
    txDetails = await new TransactionBuilder({ provider })
    .addInput(failMinterUTXO, contractCashStarterStop.unlock.stop())
    .addInput(campaignUTXO, contractCashStarter.unlock.externalFunction())
    .addOutput({
      to: AddressTokensCashStarterStop,  
      amount: failMinterUTXO.satoshis,
        token: {
          amount: failMinterUTXO.token?.amount!,  
          category: failMinterUTXO.token?.category!,  
          nft: {
            capability: failMinterUTXO.token?.nft?.capability!, 
            commitment: failMinterUTXO.token?.nft?.commitment!
          }
        },
    })
    .setLocktime(blockHeight)

    if (campaignUTXO.satoshis > 1000) {
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


    console.log('transaction pre-build: ');
    console.log(txDetails);

    try {                                                                        
      const rawTransactionHex = await txDetails.build();          // build the transaction we created                          

      console.log('finished cashstarterStop()');
      return rawTransactionHex;

    } catch (error) {
      console.log('cashstarterFail(): tx build failed: ' + error);
    }
  }
}
  
export default cashstarterStop;