// @ts-nocheck
import { Contract, Utxo, TransactionBuilder, ElectrumNetworkProvider, Network, Unlocker } from 'cashscript';
import { hexToBin, cashAddressToLockingBytecode, decodeTransaction } from '@bitauth/libauth';
import { AddressCashStarter, AddressTokensCashStarter, AddressCashStarterRefund, AddressTokensCashStarterRefund, MasterCategoryID } from './values'

interface CashStarterRefundParams {
  electrumServer: ElectrumNetworkProvider | undefined;
  usersAddress: string;
  contractCashStarter: Contract | undefined;
  contractCashStarterRefund: Contract | undefined;
  campaignID: string;
  selectedNFT: Utxo;
  signTransaction: (options: any) => Promise<unknown>;
  setError: (message: string) => void;
}

async function cashstarterRefund({ electrumServer, usersAddress, contractCashStarter, contractCashStarterRefund, campaignID, selectedNFT, signTransaction, setError }: CashStarterRefundParams) {

  function hexLEToBigInt(hexLE: string): bigint {
    // Convert the hex string from little-endian to big-endian
    const hexBE = hexLE.match(/.{2}/g)?.reverse().join('') ?? '0';
    // Convert the big-endian hex string directly to a BigInt
    return BigInt('0x' + hexBE);
  }
  function LEtoBE(hexLE: string) {
    // Convert the hex string from little-endian to big-endian
    const hexBE = hexLE.match(/.{2}/g)?.reverse().join('') ?? '0';
    return hexBE;
  }

  if (electrumServer && contractCashStarter && contractCashStarterRefund) {
    console.log('contract address: ', contractCashStarter.address, ' refundContract: ', contractCashStarterRefund);
      //Creating lockingBytecode for contract addresses
      const contractLockingBytecodeResult = cashAddressToLockingBytecode(AddressCashStarter);
      if (typeof contractLockingBytecodeResult === 'string') {
        throw new Error(`Failed to convert CashAddress to locking bytecode: ${contractLockingBytecodeResult}`);
      }
      const refundLockingBytecodeResult = cashAddressToLockingBytecode(AddressCashStarterRefund);
      if (typeof refundLockingBytecodeResult === 'string') {
        throw new Error(`Failed to convert CashAddress to locking bytecode: ${contractLockingBytecodeResult}`);
      }
      //Creating lockingBytecode for usersAddress
      //const lockingBytecodeResult = cashAddressToLockingBytecode(usersAddress);
      const lockingBytecodeResult = cashAddressToLockingBytecode(usersAddress);
      if (typeof lockingBytecodeResult === 'string') {
        throw new Error(`Failed to convert CashAddress to locking bytecode: ${lockingBytecodeResult}`);
      }

    ///////////Get all utxos on contract      
    const contractUTXOs = await contractCashStarter.getUtxos(); 
    console.log('contract utxos:');
    console.log(contractUTXOs);

    //Find campaignNFT
    const contractUTXO: Utxo = contractUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && (utxo.token?.nft?.capability === 'minting' || utxo.token?.nft?.capability === 'mutable')
      && utxo.token?.nft?.commitment.substring(70,80) === campaignID,
    )!;
    console.log('selected campaignNFT UTXO: ');
    console.log(contractUTXO);

    ///////////Get all utxos on refund contract      
    const refundUTXOs = await contractCashStarterRefund.getUtxos(); 
    console.log('refund utxos:');
    console.log(refundUTXOs);

    //Find refundNFT
    const refundUTXO: Utxo = refundUTXOs.find(
      utxo => utxo.token?.category === MasterCategoryID
      && utxo.token?.nft?.capability === 'minting'
      && utxo.token?.nft?.commitment.substring(70,80) === 'ffffffffff' //is the masterNFT,
    )!;
    console.log('selected refundContract UTXO: ');
    console.log(refundUTXO);

    ///////////Get users receiptNFT      
    console.log('selected pledge receipt utxo: ');
    console.log(selectedNFT);

  // Build transaction      

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

    const refundSatoshis = hexLEToBigInt(selectedNFT.token?.nft?.commitment.substring(0,12) ?? "0");
    const newCampaignTotal = contractUTXO.satoshis - refundSatoshis;
    const provider = new ElectrumNetworkProvider(Network.MAINNET);

    let txDetails = await new TransactionBuilder({ provider });
    try {
      txDetails
        .addInput(refundUTXO, contractCashStarterRefund.unlock.refund())
        .addInput(contractUTXO, contractCashStarter.unlock.externalFunction())
        .addInput(selectedNFT, p2pkhUnlocker)
        .addOutput({  //refundUTXO back to refund contract
          to: AddressTokensCashStarterRefund,  
          amount: refundUTXO.satoshis,
            token: {
              amount: refundUTXO.token?.amount!,  
              category: refundUTXO.token?.category!,  
              nft: {
                capability: refundUTXO.token?.nft?.capability!, 
                commitment: refundUTXO.token?.nft?.commitment!  
              }
            },
        })

        if (contractUTXO.satoshis > refundSatoshis) {
          txDetails.addOutput({  //campaignNFT back to CashStarter contract
            to: AddressTokensCashStarter,  
            amount: newCampaignTotal,
              token: {
                amount: contractUTXO.token?.amount!,  
                category: contractUTXO.token?.category!,  
                nft: {
                  capability: contractUTXO.token?.nft?.capability!, 
                  commitment: contractUTXO.token?.nft?.commitment!  
                }
              },
          })
        }
        
        txDetails.addOutput({  //refund back to user
          to: usersAddress,  
          amount: refundSatoshis - 1000n, //1000n miner fee comes from whats already on users receiptNFT
        })

        console.log('txDetails:');
        console.log(txDetails);

        //const debugged = transaction.debug();
        //console.log(debugged);

        //const txid = await transaction.send();
        //console.log(txid);

    } catch (error) {
      if (error instanceof Error) {
        setError(`Error refunding: ${error.message}`);
        console.error('Error refunding:', error);
      } else {
        setError(`Error refunding: ${error}`);
        console.error('Error refunding:', error);
      }
    }

    try {                                                                        // build the transaction we created
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
      const binTokenCategory = hexToBin(selectedNFT.token?.category!);
      const refundBinCommitment = hexToBin(refundUTXO.token?.nft?.commitment!);
      const campaignBinCommitment = hexToBin(contractUTXO.token?.nft?.commitment!);
      const receiptBinCommitment = hexToBin(selectedNFT.token?.nft?.commitment!);

      const listSourceOutputs = [{
          ...decodedTransaction.inputs[0],
          lockingBytecode: (cashAddressToLockingBytecode(contractCashStarterRefund!.tokenAddress) as { bytecode: Uint8Array }).bytecode,
          valueSatoshis: BigInt(refundUTXO.satoshis),
          contract: {
            abiFunction: contractCashStarterRefund.artifact.abi,
            redeemScript: contractCashStarterRefund.redeemScript,
            artifact: contractCashStarterRefund.artifact,
          },
          token: {
            amount: refundUTXO?.token?.amount,
            category: binTokenCategory,
            nft: {
              capability: refundUTXO.token?.nft?.capability!,    // NFT's capability
              commitment: refundBinCommitment     // NFT's nftCommitment field
            }
          }
        },
        {
          ...decodedTransaction.inputs[1],
          lockingBytecode: (cashAddressToLockingBytecode(contractCashStarter!.tokenAddress) as { bytecode: Uint8Array }).bytecode,
          valueSatoshis: BigInt(contractUTXO.satoshis),
          contract: {
            abiFunction: contractCashStarter.artifact.abi,
            redeemScript: contractCashStarter.redeemScript,
            artifact: contractCashStarter.artifact,
          },
          token: {
            amount: contractUTXO?.token?.amount,
            category: binTokenCategory,
            nft: {
              capability: contractUTXO.token?.nft?.capability!,    // NFT's capability
              commitment: campaignBinCommitment     // NFT's nftCommitment field
            }
          }
        },
        {
          ...decodedTransaction.inputs[2],
          lockingBytecode: (cashAddressToLockingBytecode(usersAddress) as { bytecode: Uint8Array }).bytecode,
          valueSatoshis: BigInt(selectedNFT.satoshis),
          token: {
            amount: selectedNFT?.token?.amount,
            category: binTokenCategory,
            nft: {
              capability: selectedNFT.token?.nft?.capability!,    // NFT's capability
              commitment: receiptBinCommitment     // NFT's nftCommitment field
            }
          }
        }];
      

      //create transaction object to give for signing
      const wcTransactionObj = {
        transaction: decodedTransaction,
        sourceOutputs: listSourceOutputs,
        broadcast: false,
        userPrompt: "Refund " + refundSatoshis + "sats from campaign #" + LEtoBE(campaignID)
      };
      console.log(wcTransactionObj);

      setError('Sent refund to your wallet for approval');
      console.log('Sent refund to your wallet for approval');

      //pass object to walletconnect for user to sign
      const signResult: any = await signTransaction(wcTransactionObj);

      return signResult;

    } catch (error) {
      console.log('Error refunding: ' + error);
      setError('Error refunding: ' + error);
    }
  }
}
  
export default cashstarterRefund;