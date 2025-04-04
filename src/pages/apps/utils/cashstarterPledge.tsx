// @ts-nocheck
import { Contract, Utxo, ElectrumNetworkProvider, SignatureTemplate } from 'cashscript';
import { hexToBin, cashAddressToLockingBytecode, decodeTransaction } from '@bitauth/libauth';
import { AddressCashStarter, AddressTokensCashStarter, MasterCategoryID } from './values'
import toTokenAddress from "./toTokenAddress"

interface CashStarterPledgeParams {
  electrumServer: ElectrumNetworkProvider | undefined;
  usersAddress: string;
  contractCashStarter: Contract | undefined;
  campaignID: string;
  pledgeID: string;
  pledgeAmount: bigint;
  signTransaction: (options: any) => Promise<unknown>;
  setError: (message: string) => void;
  setGotConsolidateError: React.Dispatch<React.SetStateAction<boolean>>;
}
interface TokenDetails {
  amount: bigint;
  category: string;
  nft?: {
      capability: 'none' | 'mutable' | 'minting';
      commitment: string;
  };
}

async function cashstarterPledge({ electrumServer, usersAddress, contractCashStarter, campaignID, pledgeID, pledgeAmount, signTransaction, setError, setGotConsolidateError }: CashStarterPledgeParams) {
  
  function toLittleEndianHexString(number: bigint, byteCount: number) {
    let hex = number.toString(16);
    hex = hex.padStart(byteCount * 2, '0'); // Pad with zeros to ensure correct byteCount
    // Split into chunks of 2 (bytes), reverse (for little endian), and join back
    return hex.match(/../g)?.reverse().join('') ?? '';
  }
  function LEtoBE(hexLE: string) {
    // Convert the hex string from little-endian to big-endian
    const hexBE = hexLE.match(/.{2}/g)?.reverse().join('') ?? '0';
    return hexBE;
  }
  const LEtoBEtoDecimal = (hex: string): number => {
    // Convert hex to big-endian and then to decimal
    const bigEndianHex = hex.match(/.{2}/g)?.reverse().join('') ?? '0';
    return parseInt(bigEndianHex, 16);
  };

  if (electrumServer && contractCashStarter) {

    //Creating lockingBytecode for contract address
    const contractLockingBytecodeResult = cashAddressToLockingBytecode(AddressCashStarter);
    if (typeof contractLockingBytecodeResult === 'string') {
      throw new Error(`Failed to convert CashAddress to locking bytecode: ${contractLockingBytecodeResult}`);
    }
    //Creating lockingBytecode for usersAddress
    const lockingBytecodeResult = cashAddressToLockingBytecode(usersAddress);
    if (typeof lockingBytecodeResult === 'string') {
      throw new Error(`Failed to convert CashAddress to locking bytecode: ${lockingBytecodeResult}`);
    }

    //########Get all utxos on contract      
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
    
    console.log('pledgeAmount: ', pledgeAmount);
    //Get users UTXOs
    const userUtxos = await electrumServer.getUtxos(usersAddress);
    console.log('user UTXOs:');
    console.log(userUtxos);

    //Find pure BCH pledge UTXO
    const userUTXO: any = userUtxos.find(
      utxo => utxo.satoshis >= (pledgeAmount + 2000n) && !utxo.token,
    )!;
    console.log('selected pledge utxo: ');
    console.log(userUTXO);

    if (!userUTXO) {
      //count up all the sats in userUTXOs that do not have a token
      const totalSats = userUtxos.reduce((sum: bigint, utxo: Utxo) => {
        if (!utxo.token) {
          return sum + utxo.satoshis;
        }
        return sum;
      }, 0n);

      if (totalSats >= pledgeAmount + 2000n) {
        console.log('Error: No compatible UTXO found in wallet, consolidate?');
        setError(`Error: No compatible UTXO found in wallet, consolidate?`);
        setGotConsolidateError(true);
      } else {
        console.log('Error: Not enough BCH in your wallet');
        console.log('total available sats in wallet: ', totalSats);
        setError(`Error: Not enough BCH in your wallet`);
      }

      return;
    }

    //########create campaignUTXO TokenDetails
      //Format of campaignNFT nftCommitment field:
      //     A(6b)       B(20b)      C(4b) D  E(4b) F(5b)
      //  ------|--------------------|----|-|----|-----   (40bytes)
      //  A: fundTarget    
      //  B: pubkeyhash
      //  C: endBlock
      //  D: empty
      //  E: pledgeID
      //  F: campaignID

    const currentPledgeID = LEtoBEtoDecimal(pledgeID);
    const newPledgeID = BigInt(currentPledgeID + 1);
    const finalPledgeID = toLittleEndianHexString(newPledgeID, 4);
    //const finalPledgeID = binToHex(bigIntToVmNumber(newPledgeID));
    console.log(finalPledgeID); 
    const newCampaignCommitment = `${campaignUTXO.token?.nft?.commitment.substring(0, 62)}${finalPledgeID}${campaignID}`;
    console.log('new campaignCommitment: ', newCampaignCommitment);

    const campaignNFTDetails: TokenDetails = {     
      amount: campaignUTXO.token?.amount!,  
      category: campaignUTXO.token?.category!,  
      nft: {
        capability: campaignUTXO.token?.nft?.capability!, 
        commitment: newCampaignCommitment
      }
    };

    //########create refundNFT commitment
    let newPledgeCommitment: string;
    if (campaignUTXO && userUTXO) {
      //Format of refundNFT nftCommitment field:
      //     A(6b)            B(29b)            C(5b) 
      //  ------|-----------------------------|-----   (40bytes)
      //  A: pledgeAmount - how many sats user gave to the mintingNFT     
      //  B: empty 
      //  C: campaignID - campaign identifier (max 1,099,511,627,774)

      const pledgeAmountHex = toLittleEndianHexString(pledgeAmount, 6);
      const campaignID = campaignUTXO.token?.nft?.commitment.substring(70, 80);
      const endBlock = campaignUTXO.token?.nft?.commitment.substring(52, 60);

      newPledgeCommitment = `${pledgeAmountHex}${'0'.repeat(42)}${endBlock}${finalPledgeID}${campaignID}`;
      console.log('new pledgeCommitment: ', newPledgeCommitment);
    }

    //##  Updated PledgeNFT details (pledge() on CashStarter contract)
    const pledgeNFTDetails: TokenDetails = {    // pledge receipt NFT
      amount: 0n,                               // 0 fungible tokens
      category: campaignUTXO.token?.category!,  // child of campaignNFT
      nft: {
        capability: 'none',                     // no capability to mint or change itself
        commitment: newPledgeCommitment!        // contains pledged amount and campaignID it was for
      }
    };

    //######## Build Transaction
    const userSig = new SignatureTemplate(Uint8Array.from(Array(32)));           // empty signature as placeholder for building process. walletconnect will replace sig later
    const usersTokenAddress = toTokenAddress(usersAddress);
    const newCampaignTotal = campaignUTXO.satoshis + (pledgeAmount);

    let transaction: any;
    try {
      transaction = contractCashStarter?.functions.pledge(pledgeAmount)                      
        .from(campaignUTXO)                                                        // contractUTXO utxo
        .fromP2PKH(userUTXO, userSig)                                              // used for privtekey signing
        .to(AddressTokensCashStarter, newCampaignTotal, campaignNFTDetails)        // send output0 back to contracts address with pledge minus miner fee
        .to(usersTokenAddress, 1000n, pledgeNFTDetails)                            // send output1 to users tokenAddress with 1000sats and NFT details
        .withoutChange()                                                           // disable automatic change output back to user (change handling below)
        .withoutTokenChange()                                                      // disable automatic change output for unused input NFTs (allow implicit burn)

        const changeAmount = userUTXO.satoshis - (pledgeAmount + 2000n);     // how many sats remain on users utxo after removing 1000sats miner fee
        if (changeAmount > 546n) {                          // if change is over dust limit then send it back to user. if not, miners keep it
          transaction.to(usersAddress, changeAmount);         
        }

        console.log(transaction);

        //const debugged = transaction.debug();
        //console.log(debugged);

        //const txid = await transaction.send();
        //console.log(txid);

    } catch (error) {
      if (error instanceof Error) {
        setError(`Error pledging: ${error.message}`);
        console.error('Error pledging:', error);
      } else {
        setError(`Error pledging: ` + error);
        console.error('Transaction failed:', error);
      }
    }

      
    console.log('transaction pre-build: ');
    console.log(transaction);
    try {                                                                        // build the transaction we created
      const rawTransactionHex = await transaction.build();                                  

      //for walletconnect
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
        lockingBytecode: (cashAddressToLockingBytecode(contractCashStarter.address) as { bytecode: Uint8Array }).bytecode,
        valueSatoshis: BigInt(campaignUTXO.satoshis),
        contract: {
          abiFunction: transaction.abiFunction,
          redeemScript: contractCashStarter.redeemScript,
          artifact: contractCashStarter.artifact,     
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
        userPrompt: "Pledge " + pledgeAmount + " to campaign #" + LEtoBE(campaignID)
      };
      console.log(wcTransactionObj);

      console.log('Sent pledge to your wallet for approval');
      setError(`Sent pledge to your wallet for approval`);

      const signResult: any = await signTransaction(wcTransactionObj);

      return signResult;    

    } catch (error) {
      console.log('Error pledging: ' + error);
      setError(`Error pledging: ${error}`);
    }
  }
}
  
export default cashstarterPledge;