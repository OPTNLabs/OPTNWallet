import { Contract, Utxo, TransactionBuilder, ElectrumNetworkProvider, Network } from 'cashscript';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import { AddressCashStarter, AddressTokensCashStarter, MasterCategoryID, AddressTokensCashStarterStop } from './values'

interface CashStarterFailParams {
  electrumServer: ElectrumNetworkProvider | undefined;
  contractCashStarter: Contract | undefined;
  contractCashStarterStop: Contract | undefined;
  campaignID: string;
}

type UtxoToken = NonNullable<Utxo['token']>;
type UtxoTokenWithNft = UtxoToken & { nft: NonNullable<UtxoToken['nft']> };

function requireToken(utxo: Utxo, context: string): UtxoTokenWithNft {
  if (!utxo.token?.nft) {
    throw new Error(`Missing token data for ${context}`);
  }
  return utxo.token as UtxoTokenWithNft;
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
    const campaignUTXO = cashStarterUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.commitment.substring(70,80) === campaignID,
    );
    if (!campaignUTXO) {
      throw new Error('Unable to find campaign UTXO for stop flow');
    }
    console.log('selected campaignNFT UTXO: ');
    console.log(campaignUTXO);

  //failMinterUTXO
    //Get all utxos on failMinter contract      
    const failMinterUTXOs = await contractCashStarterStop.getUtxos(); 
    console.log('failMinter utxos:');
    console.log(failMinterUTXOs);

    //Find failMinter minting NFT
    const failMinterUTXO = failMinterUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.capability == 'minting',
    );
    if (!failMinterUTXO) {
      throw new Error('Unable to find fail minter UTXO for stop flow');
    }
    console.log('selected failMinterNFT UTXO: ');
    console.log(failMinterUTXO);

    const provider = new ElectrumNetworkProvider(Network.MAINNET);

    const txDetails = await new TransactionBuilder({ provider })
    .addInput(failMinterUTXO, contractCashStarterStop.unlock.stop())
    .addInput(campaignUTXO, contractCashStarter.unlock.externalFunction())
    .addOutput({
      to: AddressTokensCashStarterStop,  
      amount: failMinterUTXO.satoshis,
        token: {
          amount: requireToken(failMinterUTXO, 'failMinterUTXO').amount,
          category: requireToken(failMinterUTXO, 'failMinterUTXO').category,
          nft: {
            capability: requireToken(failMinterUTXO, 'failMinterUTXO').nft.capability,
            commitment: requireToken(failMinterUTXO, 'failMinterUTXO').nft.commitment
          }
        },
    })
    .setLocktime(blockHeight)

    if (campaignUTXO.satoshis > 1000) {
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
