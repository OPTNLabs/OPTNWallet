// @ts-nocheck
import { Contract, Utxo, ElectrumNetworkProvider, SignatureTemplate } from 'cashscript';
import { hexToBin, binToHex, bigIntToVmNumber, cashAddressToLockingBytecode, decodeTransaction } from '@bitauth/libauth';
import { AddressCashStarter, AddressTokensCashStarter, AddressTokensCashStarterManager, MasterCategoryID } from './values'

interface ManagerInitializeParams {
  electrumServer: ElectrumNetworkProvider | undefined;
  usersAddress: string;
  contractManager: Contract | undefined;
  signTransaction: (options: any) => Promise<unknown>;
  pubkeyhash: string;
  fundTarget: string;
  endBlock: string;
  setError: (message: string) => void;
}
interface TokenDetails {
  amount: bigint;
  category: string;
  nft?: {
      capability: 'none' | 'mutable' | 'minting';
      commitment: string;
  };
}

async function managerInitialize({ electrumServer, usersAddress, contractManager, signTransaction, pubkeyhash, fundTarget, endBlock, setError }: ManagerInitializeParams) {

  function toLittleEndianHexString(number: bigint, byteCount: number) {
    let hex = number.toString(16);
    hex = hex.padStart(byteCount * 2, '0'); // Pad with zeros to ensure correct byteCount
    // Split into chunks of 2 (bytes), reverse (for little endian), and join back
    return hex.match(/../g)?.reverse().join('') ?? '';
  }
  
  if (electrumServer && contractManager) {

    const serviceAddress = "bitcoincash:qrx6fypj230kpgvghmyje089sphvl4jnfqq4aduatz";    //mainnet FundMe-OPTN
    const servicePKH = 'cda49032545f60a188bec92cbce5806ecfd65348';                      //mainnet FundMe-OPTN PKH
    
    const serviceFee = 1000000n; //FundMe create fee

      //Creating lockingBytecode for contract address
    const contractLockingBytecodeResult = cashAddressToLockingBytecode(AddressCashStarter);
    if (typeof contractLockingBytecodeResult === 'string') {
      throw new Error(`Failed to convert CashAddress to locking bytecode: ${contractLockingBytecodeResult}`);
    }
    //Creating lockingBytecode for selectedNFT
    const lockingBytecodeResult = cashAddressToLockingBytecode(usersAddress);
    if (typeof lockingBytecodeResult === 'string') {
      throw new Error(`Failed to convert CashAddress to locking bytecode: ${lockingBytecodeResult}`);
    }

    // Get all utxos on contract      
    const contractUTXOs = await contractManager.getUtxos(); 
    console.log('contract utxos:');
    console.log(contractUTXOs);

    //find masterNFT
    const contractUTXO: Utxo = contractUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.capability === 'minting'
    )!; 
    console.log('selected masterNFT UTXO: ');
    console.log(contractUTXO);

    //Get users UTXOs
    const userUtxos = await electrumServer.getUtxos(usersAddress);
    console.log('user UTXOs:');
    console.log(userUtxos);
    //Find pure BCH pledge UTXO
    const userUTXO: any = userUtxos.find(
      utxo => utxo.satoshis >= (serviceFee + 2000n) && !utxo.token, //userUTXO needs at least serviceFee + 1000n for campaignUTXO + 1000n for miner fee
    )!;
    console.log('selected pledge utxo: ');
    console.log(userUTXO);

    if (!userUTXO) {
      console.log('No compatible UTXO found from users wallet');
      return;
    }

    //get current campaignCounter and build new commitments for masterNFT and new campaignNFT
    let newMasterCommitment: any;
    let newCampaignCommitment: any;
    let newCampaignID: number = 0;
    if (contractUTXO) {
      const contractCommitment = contractUTXO.token?.nft?.commitment!;
      console.log('existing masterNFT commitment (LE): ', contractCommitment);
      
      //Format of CashStarterManager's masterNFT commitment (this masterNFT's nftCommitment field):
      //  A(5b)  B(5b)        C(25b)           D(5b)
      //  -----|-----|------------------------|-----   (40bytes)     
      //  A: campaignCounter - number of campaigns created by this contract.
      //  B: claimedCampaigns - number of campaigns that have been claimed.
      //  C: empty
      //  D: campaignID - 1099511627775 (max 5byte value) which is used to identify the masterNFT

      //increment campaignCounter
      const bigEndianCommitment = contractCommitment.match(/.{2}/g)?.reverse().join('') || '';  //convert from LittleEndian to BigEndian
      console.log('existing masterNFT commitment (BE): ', bigEndianCommitment);

      const campaignIDBigEndian = parseInt(bigEndianCommitment.substring(70, 80), 16);
      console.log('existing campaignID on commitment (BE): ', campaignIDBigEndian);
      newCampaignID = campaignIDBigEndian + 1;
      console.log('newCampaign ID (BE): ', newCampaignID);
      const newCampaignIDHexBigEndian = newCampaignID.toString(16).padStart(10, '0');
      const newCampaignIDHexLittleEndian = newCampaignIDHexBigEndian.match(/.{2}/g)?.reverse().join('') || '';
      console.log('newCampaign ID Hex (LE): ', newCampaignIDHexLittleEndian);

      newMasterCommitment = newCampaignIDHexLittleEndian + bigEndianCommitment.substring(0, 70).match(/.{2}/g)?.reverse().join('');
      console.log('new masterCommitment: ', newMasterCommitment);

      //Format of campaignNFT commitment field after initialize():
      //  A(6b)        B(20b)        C(4b) D(5b) E(5b)
      //  ------|--------------------|----|-----|-----   (40bytes)
      //  A: fundTarget - the target amount user is trying to fundraise (max 281,474 BCH)
      //  B: payoutAddress - the pubkeyhash the raised funds can be withdrawn to if fully funded              
      //  C: endBlock - block number the campaign ends at (max 499,999,999 (year ~11,500))
      //  D: empty
      //  E: campaignID - the campaigns unique identifier

      console.log('fundTarget:', fundTarget);
      const fundTargetInSatoshis = Math.round(Number(fundTarget) * 100000000);

      // Ensure all numbers are non-negative
      if (fundTargetInSatoshis < 0 || Number(endBlock) < 0 || newCampaignID < 0) {
        throw new Error("Invalid input: negative values are not allowed.");
      }

      const fundTargetHex = binToHex(bigIntToVmNumber(BigInt(fundTargetInSatoshis))); 
      let padLength = 12 - fundTargetHex.length;
      let paddedfundTargetHex = fundTargetHex + '0'.repeat(padLength);

      const endBlockHex = toLittleEndianHexString(BigInt(endBlock), 4);
      const newCampaignIDHex = toLittleEndianHexString(BigInt(newCampaignID), 5);

      newCampaignCommitment = `${paddedfundTargetHex}${pubkeyhash}${endBlockHex}${'0'.repeat(10)}${newCampaignIDHex}`;
      console.log('new campaignCommitment: ', newCampaignCommitment);
    }

    //##  Updated MasterNFT details (initialize() on Manager contract )
    const masterNFTDetails: TokenDetails = { 
      amount: contractUTXO.token?.amount!,
      category: contractUTXO.token?.category!,
      nft: {
        capability: contractUTXO.token?.nft?.capability!,
        commitment: newMasterCommitment! 
      }
    };
    //##  Updated CampaignNFT details (initialize() on Manager contract )
    const campaignNFTDetails: TokenDetails = {    // creating the NFT Manager will recreate
      amount: 0n,                                 // 0 fungible tokens
      category: contractUTXO.token?.category!,    // txid of users input
      nft: {
        capability: 'minting',                    // NFT's capability
        commitment: newCampaignCommitment!        // NFT's nftCommitment field
      }
    };

    const userSig = new SignatureTemplate(Uint8Array.from(Array(32)));           // empty signature as placeholder for building process. walletconnect will replace sig later

  let transaction: any;
  const fundTargetInSatoshis = Math.round(Number(fundTarget) * 100000000);
  const fundTargetInBigInt = BigInt(fundTargetInSatoshis);
  const endBlockInBigInt = BigInt(Number(endBlock));

  try {
    transaction = contractManager?.functions.initialize(pubkeyhash, fundTargetInBigInt, endBlockInBigInt, servicePKH, serviceFee)                      
      .from(contractUTXO)                                                        // contractUTXO utxo
      .fromP2PKH(userUTXO, userSig)                                              // feeUTXO
      .to(AddressTokensCashStarterManager, 1000n, masterNFTDetails)              // send output0 back to contractManager address with whatever satoshis the utxo already had
      .to(AddressTokensCashStarter, 1000n, campaignNFTDetails)                   // create new campaignNFT to contract address
      .to(serviceAddress, serviceFee)                                            // fee to service provider
      .withoutChange()                                                           // disable automatic change output back to user (see next)
      .withoutTokenChange()                                                      // disable automatic change output for unused input NFTs (allow implicit burn)

      const changeAmount = userUTXO.satoshis - (3000n + serviceFee);             // how many sats remain on users utxo after removing 1000sats miner fee + 1000sats for campaignNFT
      if (changeAmount > 546n) {                                                 // if change is over dust limit then send it back to user. if not, miners keep it
        transaction.to(usersAddress, changeAmount);         
      }

      console.log('build transaction:');
      console.log(transaction);

      //const debugged = transaction.debug();
      //console.log(debugged);

      //const txid = await transaction.send();
      //console.log(txid);

  } catch (error) {
    if (error instanceof Error) {
      setError(`Error creating campaign: ${error.message}`);
      console.error('Error creating campaign:', error);
    } else {
      setError('Error creating campaign: ' + error);
      console.error('Error creating campaign: ', error);
    }
  }

    try {     // build the transaction we created
      const rawTransactionHex = await transaction!.build();                                  

      // for walletconnect
      const decodedTransaction = decodeTransaction(hexToBin(rawTransactionHex));            
      if (typeof decodedTransaction === "string") {
        alert("No suitable utxos found for minting. Try to consolidate your utxos!");
        throw ("No suitable utxos found for minting. Try to consolidate your utxos!");
      }
      decodedTransaction.inputs[1].unlockingBytecode = Uint8Array.from([]);
      console.log('decodedTransaction: ');
      console.log(decodedTransaction);

      // construct new transaction object for SourceOutputs, for stringify & not to mutate current network provider 
      const listSourceOutputs = [{
        ...decodedTransaction.inputs[0],
        lockingBytecode: (cashAddressToLockingBytecode(contractManager.address) as { bytecode: Uint8Array }).bytecode,
        valueSatoshis: BigInt(contractUTXO.satoshis),
        contract: {
          abiFunction: contractManager.artifact.abi,  //transaction as any.abiFunction
          redeemScript: contractManager.redeemScript,
          artifact: contractManager.artifact,
        }
      }, {
        ...decodedTransaction.inputs[1],
        lockingBytecode: (cashAddressToLockingBytecode(usersAddress) as { bytecode: Uint8Array }).bytecode,
        valueSatoshis: BigInt(userUTXO.satoshis),
      }];

      //create transaction object to give for signing
      const wcTransactionObj = {
        transaction: decodedTransaction,
        sourceOutputs: listSourceOutputs,
        broadcast: false,
        userPrompt: "Create Campaign #" + newCampaignID
      };
      console.log(wcTransactionObj);

      //pass object to walletconnect for user to sign
      const signResult: any = await signTransaction(wcTransactionObj);      

      console.log('finished managerInitialize()');
      if (newCampaignID != 0) {
        console.log(signResult);
        return {signResult, newCampaignID};
      }
      
      //return rawTransactionHex;

    } catch (error) {
      console.log('Error creating campaign: ' + error);
      setError('Error creating campaign: ' + error);
    }
  }
}
  
export default managerInitialize;