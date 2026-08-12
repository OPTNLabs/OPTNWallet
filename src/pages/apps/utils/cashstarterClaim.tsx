// @ts-nocheck
import { Contract, Utxo, TransactionBuilder, ElectrumNetworkProvider, Network, Unlocker } from 'cashscript';
import { hexToBin, cashAddressToLockingBytecode, decodeTransaction, encodeCashAddress } from '@bitauth/libauth';
import { AddressCashStarter, AddressCashStarterClaim, MasterCategoryID } from './values'
import findUtxo from './findUtxo';

interface CashStarterClaimParams {
  electrumServer: ElectrumNetworkProvider | undefined;
  usersAddress: string;
  contractCashStarter: Contract | undefined;
  contractCashStarterClaim: Contract | undefined;
  campaignID: string;
  signTransaction: (options: any) => Promise<unknown>;
  setError: (message: string) => void;
}

async function cashstarterClaim({ electrumServer, usersAddress, contractCashStarter, contractCashStarterClaim, campaignID, signTransaction, setError }: CashStarterClaimParams): Promise<any> {
  
  function LEtoBE(hexLE: string) {
    // Convert the hex string from little-endian to big-endian
    const hexBE = hexLE.match(/.{2}/g)?.reverse().join('') ?? '0';
    return hexBE;
  }
  function hexToUint8Array(hexString: any) {
    const bytes = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hexString.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  if (electrumServer && contractCashStarter && contractCashStarterClaim) {
    console.log('cashStarter address: ', contractCashStarter.address);
    console.log('cashStarterClaim address: ', contractCashStarterClaim.address);

    //Creating lockingBytecode for cashStarter contract address
    const contractLockingBytecodeResult = cashAddressToLockingBytecode(AddressCashStarter);
    if (typeof contractLockingBytecodeResult === 'string') {
      throw new Error(`Failed to convert CashAddress to locking bytecode: ${contractLockingBytecodeResult}`);
    }
    //Creating lockingBytecode for cashManager contract address
    const claimLockingBytecodeResult = cashAddressToLockingBytecode(AddressCashStarterClaim);
    if (typeof claimLockingBytecodeResult === 'string') {
      throw new Error(`Failed to convert CashAddress to locking bytecode: ${claimLockingBytecodeResult}`);
    }

//claimContract masterNFT
    //Get all utxos on cashStarterClaim contract      
    const claimContractUTXOs = await contractCashStarterClaim.getUtxos(); 
    console.log('cashManager utxos:');
    console.log(claimContractUTXOs);

    //Find manager's masterNFT
    const claimContractUTXO: Utxo = claimContractUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.capability === 'minting'
      && utxo.token.nft?.commitment.substring(70, 80) == 'ffffffffff' //is the masterNFT
    )!;
    console.log('selected claimContract masterNFT: ');
    console.log(claimContractUTXO);

//cashStarter campaignNFT
    //Get all utxos on cashStarter contract      
    const cashStarterUTXOs = await contractCashStarter.getUtxos(); 
    console.log('cashStarter utxos:');
    console.log(cashStarterUTXOs);

    //Find campaignNFT
    const campaignUTXO: Utxo = cashStarterUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.commitment.substring(70,80) === campaignID,
    )!;
    console.log('selected cashStarter UTXO: ');
    console.log(campaignUTXO);

  //users feeUTXO
    //Get all utxos on users address   
    const userUTXOs = await electrumServer.getUtxos(usersAddress);
    console.log('users UTXOs:');
    console.log(userUTXOs);

    const userUTXO = findUtxo({ utxos: userUTXOs, minValue: 1000n });
    console.log('selected userUTXO: ');
    console.log(userUTXO);
    if (typeof userUTXO === 'string') {
      throw new Error(`Failed to find valid userUTXO: ${userUTXO}`);
    }

/*
//prepare new cashManager masterNFT commitment
      //  CashStarterManager's masterNFT nftCommitment field
      //     A(5b) B(5b)        C(25b)            D(5b)
      //    -----|-----|------------------------|-----   (40bytes)     
      //  A: campaignCounter - number of campaigns created by this contract.
      //  B: claimedCampaigns - number of campaigns that have been claimed.
      //  C: empty
      //  D: campaignID - 1099511627775 (max 5byte value) which is used to identify the masterNFT
    }
*/

//get payoutAddress
    let payoutAddress: any;
    if (campaignUTXO) {
      const campaignCommitment = campaignUTXO.token?.nft?.commitment!;
      //  Format of mintingNFT (campaign) nftCommitment field after initialize():
      //    A(6b)        B(20b)        C(4b) D(5b) E(5b)
      //  ------|--------------------|----|-----|-----   (40bytes)
      //  A: fundTarget - the target amount user is trying to fundraise (max 2,814,749 BCH)
      //  B: payoutAddress - the pubkeyhash the raised funds can be withdrawn to if fully funded              
      //  C: endBlock - block number the campaign ends at (max 499,999,999 (year ~11,500))
      //  D: empty
      //  E: campaignID - the campaigns unique identifier

      const payoutAddressLE = campaignCommitment.substring(12,52);
      const payoutAddressBE = LEtoBE(payoutAddressLE);
      payoutAddress = encodeCashAddress("bitcoincash", "p2pkh", hexToUint8Array(payoutAddressBE));
      console.log('extracted payoutAddress: ', payoutAddress);
    }

    const serviceAddress = "bitcoincash:qrx6fypj230kpgvghmyje089sphvl4jnfqq4aduatz";    //mainnet FundMe-OPTN
    const servicePKH = 'cda49032545f60a188bec92cbce5806ecfd65348';                      //mainnet FundMe-OPTN PKH
    const serviceFee = campaignUTXO.satoshis * 15n / 1000n; //FundMe flat 1.5% claim fee

    const finalPayout = (campaignUTXO.satoshis + userUTXO.satoshis) - (serviceFee + 1000n);
    if (finalPayout <= 0) {
      throw new Error(`finalPayout not valid: ${finalPayout}`);
    }

    const p2pkhUnlocker: Unlocker = {
      generateLockingBytecode: () => {    // Return the locking bytecode (scriptPubKey) for the P2PKH output
        const result = cashAddressToLockingBytecode(usersAddress);

        if (typeof result === 'string') {
          throw new Error(`Failed to convert CashAddress to locking bytecode: ${result}`);
        }
        return result.bytecode;
      },
      generateUnlockingBytecode: () => {    // Return an empty array or a placeholder for the unlocking bytecode (scriptSig)
        return Uint8Array.from([]);
      }
    };

    const provider = new ElectrumNetworkProvider(Network.MAINNET);
    
    const txDetails = await new TransactionBuilder({ provider })
      .addInput(claimContractUTXO, contractCashStarterClaim.unlock.claim(servicePKH, serviceFee))
      .addInput(campaignUTXO, contractCashStarter.unlock.externalFunction())
      .addInput(userUTXO, p2pkhUnlocker)
      .addOutput({
        to: contractCashStarterClaim.tokenAddress,  
        amount: claimContractUTXO.satoshis,
        token: {
          amount: claimContractUTXO.token?.amount!,  
          category: claimContractUTXO.token?.category!,  
          nft: {
            capability: claimContractUTXO.token?.nft?.capability!, 
            commitment: claimContractUTXO.token?.nft?.commitment!  
          }
        },
      })
      .addOutput({
        to: usersAddress,  
        amount: finalPayout,
      })
      .addOutput({
        to: serviceAddress,
        amount: serviceFee,
      })
      .setMaxFee(2000n)

      console.log('transaction pre-build: ');
      console.log(txDetails);

    try {       // build the transaction we created
      const rawTransactionHex = await txDetails.build();                                  

      // for walletconnect
      const decodedTransaction = decodeTransaction(hexToBin(rawTransactionHex));            
      if (typeof decodedTransaction === "string") {
        alert("No suitable utxos found for minting. Try to consolidate your utxos!");
        throw ("No suitable utxos found for minting. Try to consolidate your utxos!");
      }
      decodedTransaction.inputs[2].unlockingBytecode = Uint8Array.from([]);
      console.log('decodedTransaction: ');
      console.log(decodedTransaction);

      // construct new transaction object for SourceOutputs, for stringify & not to mutate current network provider 
      const binTokenCategory = hexToBin(campaignUTXO.token?.category!);
      const claimBinCommitment = hexToBin(claimContractUTXO.token?.nft?.commitment!);
      const campaignBinCommitment = hexToBin(campaignUTXO.token?.nft?.commitment!);

      const listSourceOutputs = [{
        ...decodedTransaction.inputs[0],
        lockingBytecode: (cashAddressToLockingBytecode(contractCashStarterClaim.address) as { bytecode: Uint8Array }).bytecode,
        valueSatoshis: BigInt(claimContractUTXO.satoshis),
        contract: {
          abiFunction: contractCashStarterClaim.artifact.abi,
          redeemScript: contractCashStarterClaim.redeemScript,
          artifact: contractCashStarterClaim.artifact, 
        },
        token: {
          amount: claimContractUTXO?.token?.amount,
          category: binTokenCategory,
          nft: {
            capability: claimContractUTXO.token?.nft?.capability!,
            commitment: claimBinCommitment
          }
        }
      }, {
        ...decodedTransaction.inputs[1],
        lockingBytecode: (cashAddressToLockingBytecode(contractCashStarter.address) as { bytecode: Uint8Array }).bytecode,
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
        userPrompt: "Claim campaign # " + LEtoBE(campaignID)
      };
      console.log(wcTransactionObj);

      console.log('Sent claim to your wallet for approval');
      setError(`Sent claim to your wallet for approval`);

      //pass object to walletconnect for user to sign
      const signResult: any = await signTransaction(wcTransactionObj);
      return signResult;

    } catch (error) {
      console.log('cashstarterClaim(): tx build failed: ' + error);
      setError(`Error claiming: ` + error);
    }
  }
}
  
export default cashstarterClaim;