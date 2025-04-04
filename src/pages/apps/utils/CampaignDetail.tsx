// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
//import { useBlockchainContext } from '../../components/Context/BlockchainContext';
import { Utxo, Contract, TransactionBuilder, ElectrumNetworkProvider, Network } from 'cashscript';
import { AddressCashStarter, MasterCategoryID } from './values'
import cashStarterPledge from './cashstarterPledge';
import cashStarterRefund from './cashstarterRefund';
import cashStarterClaim from './cashstarterClaim';
import cashStarterStop from './cashstarterStop';
import cashStarterCancel from './cashstarterCancel';
//import ArtifactCashStarter from '../../contracts/FundMeV8_Mainnet/json/CashStarter.json';
//import ArtifactCashStarterRefund from '../../contracts/FundMeV8_Mainnet/json/CashStarterRefund.json';
//import ArtifactCashStarterStop from '../../contracts/FundMeV8_Mainnet/json/CashStarterStop.json';
//import ArtifactCashStarterClaim from '../../contracts/FundMeV8_Mainnet/json/CashStarterClaim.json';
//import ArtifactCashStarterCancel from '../../contracts/FundMeV8_Mainnet/json/CashStarterCancel.json';
import { stringify } from '@bitauth/libauth';
import axios, { AxiosError } from 'axios';
import PledgeModal from './PledgeModal';
import ConsolidateModal from './ConsolidateModal';
//import { environmentUrl } from '../../constants/environment';
import consolidateUTXOs from './consolidateUTXOs';
//import RichTextEditor from '../../components/RichTextEditor';
import { Buffer } from 'buffer';
//import { toast } from 'react-toastify';
import { Toast } from '@capacitor/toast';
import { RootState } from '../../../redux/store';
import ElectrumServer from '../../../apis/ElectrumServer/ElectrumServer';
import BCHLogo from './bch.png';
import { useNavigate } from 'react-router-dom';

interface Pledge {
  campaignID: string;
  pledgeID: string;
  name: string;
  message: string;
  amount: number;
}
interface Update {
  number: number;
  text: string;
}

interface CampaignUtxo extends Utxo {
  name: string;
  owner: string;
  description: string;
  logo: string;
  banner: string;
  pledges: Pledge[];
  ownersAddress: string;
  updates: Update[];
  isComplete: boolean;
}
interface SignMessageParams {
  message: string;
  userPrompt?: string;
}
interface SignTransactionParams {
  tx: string;
}
type NetworkType = "mainnet" | "testnet4" | "chipnet";

const CampaignDetail: React.FC = () => {
  const { id } = useParams(); // Get the campaign ID from the URL
  //const { walletConnectSession, walletConnectInstance, electrumServer, electrumCluster, usersAddress, connectedChain } = useBlockchainContext();
  const [campaignUTXO, setCampaignUTXO] = useState<Utxo>();
  const [campaignMap, setCampaignMap] = useState<Map<number, CampaignUtxo | null>>(new Map());
  const [contractsOK, setContractsOK] = useState(false);
  const [contractCashStarter, setContractCashStarter] = useState<Contract>();
  const [contractCashStarterRefund, setContractCashStarterRefund] = useState<Contract>();
  const [contractCashStarterStop, setContractCashStarterStop] = useState<Contract>();
  const [contractCashStarterClaim, setContractCashStarterClaim] = useState<Contract>();
  const [contractCashStarterCancel, setContractCashStarterCancel] = useState<Contract>();
  const [contractManager, setContractManager] = useState<Contract>();
  const [contractFailMinter, setContractFailMinter] = useState<Contract>();
  const [stringPledgeAmount, setStringPledgeAmount] = useState<string>("");
  const [selectedNFT, setSelectedNFT] = useState<Utxo | null>();
  const [nfts, setNFTs] = useState<Utxo[]>([]);
  const [isExpired, setIsExpired] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [isFailed, setIsFailed] = useState(false);
  const [isClaimed, setIsClaimed] = useState(false);
  const [selectedTab, setSelectedTab] = useState('Overview');
  const [transactionBuilder, setTransactionBuilder] = useState<TransactionBuilder>();
  const [endDate, setEndDate] = useState('');
  const [endBlock, setEndBlock] = useState(0);
  const [campaignInfo, setCampaignInfo] = useState<CampaignUtxo>();
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [txPending, setTXPending] = useState(false);
  const [refundPending, setRefundPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [claimPending, setClaimPending] = useState(false);
  const [error, setError] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [pledgeDetails, setPledgeDetails] = useState({ name: '', message: '' });
  const [pledgeTotal, setPledgeTotal] = useState<number>(0);
  const [gotConsolidateError, setGotConsolidateError] = useState<boolean>(false);
  //update campaign info
  const [updateText, setUpdateText] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const [urlAddress, setUrlAddress] = useState('');
  const MAX_CAMPAIGN_SIZE_MB = 25; // Maximum allowed size in MB
  const navigate = useNavigate();

  const [usersAddress, setUsersAddress] = useState('bitcoincash:qz500000000000000000000000000000000000000000000000000000000000000');
  // Create an instance of ElectrumServer
  const electrumServer = ElectrumServer();

  //////////Compile an artifact into a CashScript Contract object
  //async function compileContract(contractArtifact: any, args: any[]) {
  //  const contract = new Contract(contractArtifact, args, {provider: electrumServer, addressType: 'p2sh32'});
  //  return contract;
  //}

  const hexToDecimal = (hex: string): number => {
    // Convert hex to big-endian and then to decimal
    const bigEndianHex = hex.match(/.{2}/g)?.reverse().join('') ?? '0';
    return parseInt(bigEndianHex, 16);
  };
  //Function to convert string to bigint
  function convertStringToBigInt(string: string): bigint {
    const bchAmount = parseFloat(string);                 //Parse the BCH string to a floating-point number
    const satoshis = Math.round(bchAmount * 100_000_000); //Convert BCH to satoshis and round the result to avoid precision issues
    return BigInt(satoshis);                              //Convert the satoshis to bigint for precise integer arithmetic
  }
  function toLittleEndianHex(value: any, byteCount: number) {
    let hex = (typeof value === 'bigint' ? value.toString(16) : Number(value).toString(16)); //Check number vs bigint and convert to hex accordingly
    hex = hex.padStart(byteCount * 2, '0'); // Pad with zeros to ensure correct byteCount
    return hex.match(/../g)?.reverse().join('') ?? '';  //Split into chunks of 2 (bytes), reverse (for little endian), and join back
  }
  const handleSelectTab = (tabName: string) => {
    setSelectedTab(tabName);
  };

  async function formatTime(blocks: number): Promise<string> {
    //const blockHeight = await electrumServer.getBlockHeight();
    const blockHeight = 90000;
    const blocksRemaining = Math.max(blocks - blockHeight, 0);

    if (blocksRemaining == 0) {
      return 'Expired';
    }

    const totalMinutes = blocksRemaining * 10;
    const totalHours = totalMinutes / 60;
    const remainingHours = totalHours % 24;
    const days = Math.floor(totalHours / 24);
    const hours = Math.floor(totalHours % 24);
    const minutes = Math.floor((remainingHours - hours) * 60);

    let endDate = '';
    if (days > 0) {
      endDate += `${days}d `;
    }
    if (hours > 0 || days > 0) { // Include hours if there are any days
      endDate += `${hours}h `;
    }
    endDate += `${minutes}m`;

    return endDate;
  }

  const formatSatoshiToBCH = (satoshis: bigint) => {
    const bch = Number(satoshis) / 100000000;
    return bch.toFixed(8);
  };
  
  async function signMessage({ message, userPrompt }: SignMessageParams): Promise<string | undefined> {
    const options = {
        message: message,
        userPrompt: userPrompt
      };

    console.log('signing message...');
    try {
        if (walletConnectInstance) {
        //const params = JSON.parse(stringify(options));
        
        console.log('wc params:');
        console.log(options);
        const result = await walletConnectInstance.request({
            chainId: connectedChain,
            topic: walletConnectSession.topic,
            request: {
                method: "bch_signMessage",
                params: options,
            },
        });
        console.log('signMessage result: ');
        console.log(result);
        return result;
        }
    } catch (error) {
        console.log('signMessage error: ' + error);
        return undefined;
    }
}

async function signTransaction(options: any) {
  console.log('signing transaction...');
  try {
      if (walletConnectInstance) {
      const params = JSON.parse(stringify(options));
      console.log('wc params:');
      console.log(params);
      //toast.info(`Requesting signature from your wallet...`);
      await Toast.show({
        text: 'Requesting signature from your wallet...',
      });
      const result = await walletConnectInstance.request({
          chainId: connectedChain,
          topic: walletConnectSession.topic,
          request: {
          method: "bch_signTransaction",
          params: params,
          },
      });
      return result;
      }
  } catch (error) {
      console.log('signTransation error: ' + error);
      return undefined;
  }
}

  // Function to take users pledge string, verify only one decimal, remove all but numbers, set state
  const handleSetPledgeAmount = (value: string) => {
    let newValue = value.replace(/[^0-9.]+/g, "").replace(/(\..*)\./g, '$1'); // Allow numbers and a single decimal point

    // Check if there's a decimal point, and if so, limit the length after it to 8
    const decimalIndex = newValue.indexOf('.');
    if (decimalIndex !== -1) {
      const integerPart = newValue.substring(0, decimalIndex);
      const decimalPart = newValue.substring(decimalIndex + 1, decimalIndex + 9); // Grab up to 8 decimal places
      newValue = `${integerPart}.${decimalPart}`;
    }

    setStringPledgeAmount(newValue !== "" ? newValue : "");
  }

  const handlePledgeModal = () => {
    setIsModalOpen(true);
  };

// Function to forward users pledge to the contract function
const handlePledge = async (name: string, message: string) => {
  setTXPending(true);

  if (electrumServer && usersAddress && campaignUTXO) {
    const campaignID = campaignUTXO.token?.nft?.commitment.substring(70, 80) ?? "0";
    const pledgeID = campaignUTXO.token?.nft?.commitment.substring(62, 70) ?? "0";;
    const pledgeAmount = convertStringToBigInt(stringPledgeAmount);
    console.log('Pledge details:', { campaignID, pledgeID, name, message, pledgeAmount });

    if (name == '') {
      name = 'Anonymous';
    }
    if (message == '') {
      message = ' ';
    }

    const signResult = await cashStarterPledge({electrumServer, usersAddress, contractCashStarter, campaignID, pledgeID, pledgeAmount, signTransaction, setError: (msg: string) => Toast.show({ text: msg }), setGotConsolidateError });

    if (signResult != undefined) {
      const rawTx = signResult.signedTransaction;
      console.log('signedTransaction from walletconnect: ');
      console.log(signResult);

      try {
        const result = await electrumServer.sendRawTransaction(rawTx);
        //toast.info(`Pledge sent! TxID:\n${result}`);
        await Toast.show({
          text: `Pledge sent! TxID:\n${result}`,
        });
        console.log('Broadcasted, txid: ' + result);

        const decimalCampaignID = hexToDecimal(campaignID);
        const decimalPledgeID = hexToDecimal(pledgeID) + 1; //pledgeID is the current pledge# on the campaignUTXO, new pledge adds 1 to it during pledging

        // Save to external server
        await axios.post('https://fundme.cash/save-pledge', { campaignID: decimalCampaignID, pledgeID: decimalPledgeID, name, message, amount: stringPledgeAmount });
        console.log('Pledge sent! TxID: ', result);

        // Update server stats with the pledge
        try {
          axios.post('https://fundme.cash/update-totalPledges', {
            txid: result
          });
        } catch (error) {
          console.error('Error updating totalPledges:', error);
        }

      } catch (error) {
        console.error('Error pledging:', error);
        await Toast.show({
          text: `Error pledging: \n${error}`,
        });
      }
    }

  } else {
    console.log('Error pledging. Is your wallet connected?');
    await Toast.show({
      text: 'Error pledging. Is your wallet connected?',
    });
  }

  setTXPending(false);
}

// Function to forward users pledge to the contract function
const handleClaim = async (campaignID: string) => {
  console.log('handleClaim camapignID: ', campaignID);
  setClaimPending(true);

  if (electrumServer && campaignID && usersAddress != '') {
    const signResult = await cashStarterClaim({electrumServer, usersAddress, contractCashStarter, contractCashStarterClaim, campaignID, signTransaction, setError: (msg: string) => Toast.show({ text: msg })});
    if (signResult != undefined) {
      const rawTx = signResult.signedTransaction;
      //const rawTx = signResult;
      console.log('signedTransaction from walletconnect: ');
      console.log(signResult);

      electrumServer.sendRawTransaction(rawTx).then((result: string) => {
        console.log('Broadcasted, txid: ' + result);
        Toast.show({
          text: `Claimed! TxID: \n${result}`,
        });

        // Update server stats with the raised BCH
        try {
          const raisedBCH = Number(campaignUTXO?.satoshis) / 100000000;
          axios.post('https://fundme.cash/update-stats', {
            raisedBCH: raisedBCH,
            txid: result
          });
        } catch (statsError) {
          console.error('Error updating stats:', statsError);
        }

      }).catch((error: Error) => {
        Toast.show({
          text: `Error claiming: \n${error}`,
        });
        console.error('Error claiming:', error);
      });
    }
  } else {
    Toast.show({
      text: `Error claiming. Is the correct wallet connected?`,
    });
    console.log('Error claiming. Is the correct wallet connected?');
  }

  setClaimPending(false);
}

// Function to cancel 
const handleCancel = async (campaignID: string) => {
  console.log('handleClaim camapignID: ', campaignID);
  setCancelPending(true);

  if (electrumServer && campaignID && usersAddress != '') {
    const signResult = await cashStarterCancel({electrumServer, usersAddress, contractCashStarter, contractCashStarterCancel, campaignID, signTransaction, setError: (msg: string) => Toast.show({ text: msg })});
    if (signResult != undefined) {
      const rawTx = signResult.signedTransaction;
      console.log('signedTransaction from walletconnect: ');
      console.log(signResult);

      // Ask user for confirmation before broadcasting
      if (window.confirm("Are you absolutely sure you want to cancel?")) {
        // User clicked OK
        electrumServer.sendRawTransaction(rawTx).then((result: string) => {
          console.log('Broadcasted, txid: ' + result);
          Toast.show({
            text: `Campaign canceled. TxID:\n${result}`,
          });
        }).catch((error: Error) => {
          console.error('Error canceling:', error);
          Toast.show({
            text: `Error canceling:\n${error}`,
          });
        });
      } else {
        // User clicked Cancel
        Toast.show({
          text: 'Cancel not submitted',
        });
        console.log('Cancel not submitted');
      }
    }
  } else {
    console.log('Error. Is your wallet connected?');
    Toast.show({
      text: `Error. Is your wallet connected?`,
    });
  }

  setCancelPending(false);
}

// Function to forward users pledge to the contract function
const handleRefund = async (campaignID: string, selectedNFT: Utxo) => {
  console.log('handleRefund camapignID: ', campaignID);
  setRefundPending(true);

  if (electrumServer && campaignID && selectedNFT) {
    const campaignID = selectedNFT.token?.nft?.commitment.substring(70, 80) ?? "0";
    const pledgeID = selectedNFT.token?.nft?.commitment.substring(62, 70) ?? "0";

    const signResult = await cashStarterRefund({electrumServer, usersAddress, contractCashStarter, contractCashStarterRefund, campaignID, selectedNFT, signTransaction, setError: (msg: string) => Toast.show({ text: msg })});
    if (signResult != undefined) {
      const rawTx = signResult.signedTransaction;
      console.log('signedTransaction from walletconnect: ');
      console.log(signResult);

      try {
        const result = await electrumServer.sendRawTransaction(rawTx);
        console.log('Broadcasted, txid: ' + result);

        const decimalCampaignID = hexToDecimal(campaignID);
        const decimalPledgeID = hexToDecimal(pledgeID);

        // Send pledge deletion notice to external server
        await axios.delete('https://fundme.cash/delete-pledge', { data: { campaignID: decimalCampaignID, pledgeID: decimalPledgeID, txid: result } });
        Toast.show({
          text: `Refund submitted. TxID:\n${result}`,
        });
      } catch (error) {
        console.error('Error refunding:', error);
        Toast.show({
          text: `Error refunding: \n${error}`,
        });
      }
    }

  } else {
    console.log('Error refunding. Did you select the correct PledgeNFT?');
    Toast.show({
      text: `Error refunding. Did you select the correct PledgeNFT?`,
    });
  }

  setRefundPending(false);

}

// Function to forward users pledge to the contract function
const handleStop = async (campaignID: string) => {
  console.log('handleStop camapignID: ', campaignID);
  setStopPending(true);

  if (electrumServer && campaignID) {

    const signResult = await cashStarterStop({electrumServer, contractCashStarter, contractCashStarterStop, campaignID });
    if (signResult != undefined) {
      //const rawTx = signResult.signedTransaction; //using walletConnect
      const rawTx = signResult; //anyone can spend
      console.log('signedTransaction from walletconnect: ');
      console.log(signResult);

      electrumServer.sendRawTransaction(rawTx).then((result: string) => {
          console.log('Broadcasted, txid: ' + result);
          Toast.show({
            text: `Campaign stopped. TxID:\n${result}`,
          });
      }).catch((error: Error) => {
          console.error('Error stopping campaign:', error);
          Toast.show({
            text: `Error stopping campaign: \n${error}`,
          });
      });

    }
  } else {
    console.log('Error stopping campaign. Is your wallet connected?');
    Toast.show({
      text: `Error stopping campaign. Is your wallet connected?`,
    });
  }

  setStopPending(false);
}

async function handleConsolidateUtxos() {
  setTXPending(true);

  if (electrumServer && usersAddress && transactionBuilder) { 
    const signResult = await consolidateUTXOs({electrumServer, usersAddress, transactionBuilder, signTransaction, setError: (msg: string) => Toast.show({ text: msg }) });
    const rawTx = signResult.signedTransaction; 
    console.log('signedTransaction from walletconnect: ');
    console.log(signResult);
    
    electrumServer.sendRawTransaction(rawTx).then((result: string) => {
      Toast.show({
        text: `Consolidated. TxID:\n${result}`,
      });
      console.log('Broadcasted, txid: ' + result);
    }).catch((error: Error) => {
      Toast.show({
        text: `Error consolidating: \n${error}`,
      });
      console.log('Error consolidating: ', error);
    });

  } else {
    console.log('Error consolidating, connect wallet or refresh?');
    Toast.show({
      text: 'Error consolidating, connect wallet or refresh?',
    });
  }
  
  setTXPending(false);
}
/*
  useEffect(() => {
    //console.log('1. useEffect called');
    async function checkAndCompileContracts() {
      //console.log('2. compiling contracts...');
      if (contractsOK === false && electrumServer) {
        try {
          const compiledCashStarter = await compileContract(ArtifactCashStarter, []);
          setContractCashStarter(compiledCashStarter);
          //const compiledFailMinter = await compileContract(ArtifactFailMinter, []);
          const compiledCashStarterRefund = await compileContract(ArtifactCashStarterRefund, []);
          setContractCashStarterRefund(compiledCashStarterRefund);
          const compiledCashStarterStop = await compileContract(ArtifactCashStarterStop, []);
          setContractCashStarterStop(compiledCashStarterStop);
          const compiledCashStarterClaim = await compileContract(ArtifactCashStarterClaim, []);
          setContractCashStarterClaim(compiledCashStarterClaim);
          const compiledCashStarterCancel = await compileContract(ArtifactCashStarterCancel, []);
          setContractCashStarterCancel(compiledCashStarterCancel);

          //setContractFailMinter(compiledFailMinter);
          setContractsOK(true);
          console.log('3. contracts OK');
        } catch (error) {
          console.log('contract compiling error: ' + error);
        }
      } else {
        console.log('electrumServer is not ready yet');
      }
    }
  
    checkAndCompileContracts();

    if (!transactionBuilder) {
      const provider = new ElectrumNetworkProvider(Network.MAINNET);
      //const provider = new ElectrumNetworkProvider(Network.CHIPNET);
      setTransactionBuilder(new TransactionBuilder({ provider }));
    }

  }, [electrumServer]);
*/
  useEffect(() => {
    async function getCampaign() {
      if (!electrumServer) return;
      console.log('electrumServer detected');

      setIsLoading(true);  //starts loading spinner graphic

      //fetch campaign metadata from server       
      let response;
      try {   
        response = await axios.get(`https://fundme.cash/get-campaign/` + id);
        const campaignInfo = response.data;
        setCampaignInfo(campaignInfo);
        const pledgeTotal = campaignInfo.pledges.reduce((sum: number, pledge: any) => sum + Number(pledge.amount), 0);
        setPledgeTotal(pledgeTotal);
        
      } catch (err) {
        const error = err as AxiosError;
        if (error.response && error.response.status === 404) {
          setFetchError(true);
        } else {
          setFetchError(true);
          console.log('fetch unknown error: ', err);
        }
        setIsLoading(false);
        return;
      }


      //delay to allow electrum to stabilize
      setTimeout(async () => {
        const cashStarterUTXOs: Utxo[] = await electrumServer.getUtxos(AddressCashStarter);
        let campaignUTXO = cashStarterUTXOs.find( 
          utxo => utxo.token?.category == MasterCategoryID //only CashStarter NFT's
            && utxo.token?.nft?.capability == 'minting' //only minting ones
            && utxo.token.nft?.commitment.substring(70, 80) != 'ffffffffff' //not the masterNFT
            && utxo.token.nft?.commitment.substring(70, 80) == toLittleEndianHex(id, 5) //this campaign id
        );

        if (!campaignUTXO) {  //no utxo found, could be failed already
          campaignUTXO = cashStarterUTXOs.find( 
            utxo => utxo.token?.category == MasterCategoryID  //only CashStarter NFT's
              && utxo.token?.nft?.capability == 'mutable'        //only fail()'d campaigns
              && utxo.token.nft?.commitment.substring(70, 80) != 'ffffffffff' //not the masterNFT
              && utxo.token.nft?.commitment.substring(70, 80) == toLittleEndianHex(id, 5) //this specific id
          );
        }
        setCampaignUTXO(campaignUTXO);  //save found campaign

        if (campaignUTXO) { //if an active or fail'd campaign was found
          const tempCampaignMap = new Map<number, CampaignUtxo>(); //Temporary map to populate with CampaignUtxo entries
          const capability = campaignUTXO.token?.nft?.capability;
          const campaignId = hexToDecimal(campaignUTXO.token?.nft?.commitment.substring(70,80) ?? "0");
          const endBlock = hexToDecimal(campaignUTXO.token?.nft?.commitment.substring(52, 60) ?? "0");
          setEndBlock(endBlock);
          const endDate = await formatTime(endBlock);

          //if campaign has already been fail()'d, disables Fail button interaction
          if (capability == 'mutable') {
            setIsFailed(true);
            setIsExpired(true);
            setEndDate(endBlock.toString());

          //if campaign is still active, or not yet fail'd
          } else if (capability == 'minting') {
            const campaignId = hexToDecimal(campaignUTXO.token?.nft?.commitment.substring(70,80) ?? "0");
            const endBlock = hexToDecimal(campaignUTXO.token?.nft?.commitment.substring(52, 60) ?? "0");
            const blockHeight = await electrumServer.getBlockHeight();

            //set whether campaign has passed its expiry block, enables Fail button
            if (blockHeight >= endBlock) {
              setIsExpired(true);
            }
            
              //set map data with block it will be endable at
              {/*
              tempCampaignMap.set(campaignId, {
                ...campaignUTXO,
                name: campaignInfo.name,
                owner: campaignInfo.owner,
                description: campaignInfo.description,
                banner: campaignInfo.banner,
                logo: campaignInfo.logo,
                endDate: endDate
              });
            */}
            setEndDate(endDate);
            //setCampaignMap(tempCampaignMap);
          }

        //else no UTXO was found but its campaignInfo was, campaign was claimed
        } else if (!campaignUTXO && campaignInfo) {
          setIsClaimed(true);
        }

        setIsLoading(false);
      }, 2000); // SetTimeout delay of 2 seconds
    }

    getCampaign();
  }, [id]);

// Get refund NFT's for listing so user can select one
async function fetchReceiptNFTs() {
  if (electrumServer && usersAddress != '') {
    try {
      const utxos: Utxo[] = await electrumServer.getUtxos(usersAddress);

      const filteredNFTs: Utxo[] = utxos.filter(utxo => 
        utxo.token?.category == MasterCategoryID
        && utxo.token?.nft?.commitment.substring(70,80) === toLittleEndianHex(id, 5) // Filter to only this campaign ID
        && utxo.token?.nft?.capability == 'none')     // Filter to only receiptNFTs
      setNFTs(filteredNFTs);
      console.log('set NFTs: ', filteredNFTs);
    } catch (error) {
      console.error('Error fetching UTXOs:', error);
    }
  }
};

////////// Campaign owner posts an update //////////
const handleSubmitUpdate = async () => {
  // Check the size of the campaign data
  const update = JSON.stringify({
    campaignID: id,
    updateText,
    isComplete,
    urlAddress,
    usersAddress
  });
  const updateSizeMB = Buffer.byteLength(update, 'utf8') / (1024 * 1024);

  if (updateSizeMB > MAX_CAMPAIGN_SIZE_MB) {
    Toast.show({
      text: `Error: Campaign size (${updateSizeMB.toFixed(2)} MB) exceeds max of (${MAX_CAMPAIGN_SIZE_MB} MB)`,
    });
    return;
  }

  try {
    const response = await axios.post(`https://fundme.cash/update-campaign`, {
      campaignID: id, // Assuming you have access to the campaign ID
      updateText,
      isComplete,
      urlAddress,
      usersAddress
    });
    if (response.status === 200) {
      // Clear the inputs after successful submission
      setUpdateText('');
      setIsComplete(false);
      setUrlAddress('');

      Toast.show({
        text: 'Update submitted',
      });
    }

  } catch (error) {
    Toast.show({
      text: 'Error submitting update, check console',
    });
    console.error('Error updating campaign:', error);
  }
};

//////////////////////////////////////////////////
////////// Return PledgeNFT UTXO
//////////////////////////////////////////////////
const NFTItem: React.FC<{ utxo: Utxo }> = ({ utxo }) => {
  const [isSelected, setIsSelected] = useState<boolean>(false);

  function handleSetSelectedNFT() {
    setIsSelected(current => !current);
    setSelectedNFT(utxo)
  }
  return (
    <div 
      onClick={handleSetSelectedNFT}
      className={`
        cursor-pointer rounded-lg p-4 
        ${isSelected ? 'bg-[#0AC18E] text-white' : 'bg-gray-800 hover:bg-gray-700'} 
        transition-colors duration-200
      `}
    >
    <div className="font-semibold mb-2">
      Pledge #{hexToDecimal(utxo.token?.nft?.commitment.substring(62, 70) ?? "0")}
    </div>
    <div className="flex items-center gap-2">
      <div 
        className="h-5 w-5 bg-cover bg-center"
        style={{ backgroundImage: `url(${BCHLogo})` }}
      />
      {formatSatoshiToBCH(BigInt(hexToDecimal(utxo.token?.nft?.commitment.substring(0, 11) ?? "0")))}
    </div>
  </div>
  );
};

  return (
    <div className="min-h-screen w-full bg-black text-gray-50">
      {/* Welcome Image */}
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>


        <div className="flex justify-between items-center mb-6">
          <button
            onClick={() => navigate('/apps')}
            className="bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded z-20"
          >
            Back to Apps
          </button>
        </div>

      <div className="absolute inset-0 bg-gradient-to-b from-[#0AC18E]/20 to-transparent" />

        <PledgeModal
          isOpen={isModalOpen}
          onRequestClose={() => setIsModalOpen(false)}
          onSubmit={handlePledge}
          pledgeAmount={stringPledgeAmount}
        />

        {gotConsolidateError && (
          <ConsolidateModal
            onRequestClose={() => setGotConsolidateError(false)}
            onSubmit={handleConsolidateUtxos}
            stringPledgeAmount={stringPledgeAmount}
          />
        )}

        {/* Campaign Exists on server */}
        {campaignUTXO && campaignInfo && (
          <div className="max-w-6xl mx-auto p-4">
            <div className="flex flex-col gap-6">
              {/* Banner Section */}
              <div className="flex flex-col">
                <div 
                  className="w-full h-[200px] bg-cover bg-center rounded-t-lg"
                  style={{ backgroundImage: `url(${campaignInfo.banner})` }}
                />
                <div className="flex items-center p-4 bg-black/50">
                  {isLoading ? (
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#0AC18E]" />
                  ) : (
                    <>
                      <div 
                        className="h-12 w-12 bg-cover bg-center rounded-full"
                        style={{ backgroundImage: `url(${campaignInfo.logo})` }}
                      />
                      <span className="ml-3 font-medium">{campaignInfo.owner}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Title */}
              <h1 className="text-2xl font-bold text-center">{campaignInfo.name}</h1>

              {/* Progress Bar */}
              <div 
                className="relative w-full h-8 bg-gray-800 rounded-full cursor-pointer"
                onClick={() => {
                  if (campaignUTXO) {
                    const currentAmount = Number(campaignUTXO.satoshis) / 100000000;
                    const targetAmount = hexToDecimal(campaignUTXO.token?.nft?.commitment.substring(0, 12) ?? "0") / 100000000;
                    const remainingAmount = (targetAmount - currentAmount).toFixed(8);
                    handleSetPledgeAmount(remainingAmount);
                  }
                }}
              >
                <div 
                  className="absolute left-0 top-0 h-full bg-[#0AC18E] rounded-full transition-all"
                  style={{ 
                    width: `${(Number(campaignUTXO.satoshis) / hexToDecimal(campaignUTXO.token?.nft?.commitment.substring(0, 12) ?? "0")) * 100}%` 
                  }}
                />
                <div className="absolute inset-0 flex justify-center items-center">
                  {((Number(campaignUTXO.satoshis) / hexToDecimal(campaignUTXO.token?.nft?.commitment.substring(0, 12) ?? "0")) * 100).toFixed(2)}%
                </div>
                <div className="absolute -bottom-6 w-full text-center text-sm">
                  {(Number(campaignUTXO.satoshis) / 100000000)} / {(hexToDecimal(campaignUTXO.token?.nft?.commitment.substring(0, 12) ?? "0") / 100000000)}
                </div>
                {!isFailed && !isClaimed && isExpired && (
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStop(campaignUTXO.token?.nft?.commitment.substring(70,80) ?? "0")
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-1 bg-red-500 text-white rounded-full hover:bg-red-600"
                  >
                    Stop
                  </button>
                )}
              </div>

              {/* Campaign Details Section */}
              <div className="bg-gray-900 rounded-lg p-6 space-y-6">
                {/* Campaign ID and End Date Row */}
                <div className="flex justify-between items-center">
                  <span><b>Campaign:</b> #{hexToDecimal(campaignUTXO.token?.nft?.commitment.substring(70,80) ?? "0")}</span>
                  {campaignUTXO.token?.nft?.capability == 'mutable' ? (
                    <span className="text-red-500">Campaign Stopped</span>
                  ) : (
                    <span><b>Ends:</b> {endDate}</span>
                  )}
                  <span><b>End Block:</b> {endBlock}</span>
                </div>

                {/* Pledge Input Section */}
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold">Make a Pledge</h3>
                  <div className="flex items-center gap-4">
                    <div 
                      className="h-10 w-10 bg-cover bg-center"
                      style={{ backgroundImage: `url(${BCHLogo})` }}
                    />
                    <input
                      type="text"
                      placeholder="0.0001"
                      value={stringPledgeAmount}
                      onChange={(e) => handleSetPledgeAmount(e.target.value)}
                      className="bg-white text-black px-4 py-2 rounded-lg"
                    />
                    <button
                      disabled={isFailed || isClaimed}
                      onClick={() => handlePledgeModal()}
                      className="px-6 py-2 bg-[#0AC18E] rounded-full disabled:bg-gray-500 disabled:cursor-not-allowed hover:bg-[#0cd9a0]"
                    >
                      {txPending ? (
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
                      ) : (
                        'Pledge'
                      )}
                    </button>
                  </div>
                </div>

                {/* NFT Refund Section */}
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold">Cancel your Pledge</h3>
                  <div className="flex gap-4 items-center">
                    <button 
                      onClick={fetchReceiptNFTs}
                      className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-full"
                    >
                      Refresh
                    </button>
                    <button
                      disabled={!selectedNFT}
                      onClick={() => handleRefund(campaignUTXO.token?.nft?.commitment.substring(70,80) ?? "0", selectedNFT!)}
                      className="px-4 py-2 bg-[#0AC18E] rounded-full disabled:bg-gray-500 disabled:cursor-not-allowed hover:bg-[#0cd9a0]"
                    >
                      {refundPending ? (
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
                      ) : (
                        'Refund'
                      )}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {nfts.map((utxo, index) => (
                      <NFTItem key={index} utxo={utxo} />
                    ))}
                  </div>
                </div>

                {/* Navigation Tabs */}
                <div className="flex border-b border-gray-700">
                  <button
                    className={`px-6 py-3 ${selectedTab === 'Overview' ? 'border-b-2 border-[#0AC18E] text-[#0AC18E]' : 'text-gray-400 hover:text-gray-200'}`}
                    onClick={() => handleSelectTab('Overview')}
                  >
                    Overview
                  </button>
                  <button
                    className={`px-6 py-3 ${selectedTab === 'Updates' ? 'border-b-2 border-[#0AC18E] text-[#0AC18E]' : 'text-gray-400 hover:text-gray-200'}`}
                    onClick={() => handleSelectTab('Updates')}
                  >
                    Updates
                  </button>
                  {campaignInfo.ownersAddress == usersAddress ? (
                    <button
                      className={`px-6 py-3 ${selectedTab === 'Claim' ? 'border-b-2 border-[#0AC18E] text-[#0AC18E]' : 'text-gray-400 hover:text-gray-200'}`}
                      onClick={() => handleSelectTab('Claim')}
                    >
                      Claim
                    </button>
                  ) : (
                    <div className="flex-grow" />
                  )}
                </div>

                {/* Content Sections */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
                  {/* Description and Updates Tab Content */}
                  <div className="lg:col-span-2 bg-gray-900 rounded-lg p-6">
                    {selectedTab === 'Overview' && (
                      <div 
                        className="prose prose-invert max-w-none"
                        dangerouslySetInnerHTML={{ __html: campaignInfo.description }} 
                      />
                    )}
                    
                    {selectedTab === 'Updates' && (
                      <div className="space-y-6">
                        {usersAddress == campaignInfo.ownersAddress && (
                          <>
                            {/*<RichTextEditor isUpdate={true} value={updateText} onChange={setUpdateText} />*/}
                            RichText Editor here
                            <button 
                              onClick={handleSubmitUpdate}
                              className="px-6 py-2 bg-[#0AC18E] rounded-full hover:bg-[#0cd9a0]"
                            >
                              Submit Update
                            </button>
                          </>
                        )}
                        
                        {campaignInfo?.updates.length > 0 ? (
                          campaignInfo?.updates.map((update: any) => (
                            <div key={update.number} className="bg-gray-800 rounded-lg p-4">
                              <div className="font-semibold mb-2">Update #{update.number}</div>
                              <div 
                                className="prose prose-invert max-w-none"
                                dangerouslySetInnerHTML={{ __html: update.text }} 
                              />
                            </div>
                          ))
                        ) : (
                          <p className="text-gray-400">No updates have been posted by the creator yet.</p>
                        )}
                      </div>
                    )}

                  {selectedTab === 'Claim' && (
                    <div className="space-y-6 text-center">
                      <button
                        disabled={(Number(campaignUTXO.satoshis)) < (hexToDecimal(campaignUTXO.token?.nft?.commitment.substring(0, 12) ?? "0"))}
                        onClick={() => handleClaim(campaignUTXO.token?.nft?.commitment.substring(70,80) ?? "0")}
                        className="px-6 py-2 bg-[#0AC18E] rounded-full disabled:bg-gray-500 disabled:cursor-not-allowed hover:bg-[#0cd9a0]"
                      >
                        {claimPending ? (
                          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
                        ) : (
                          'Claim'
                        )}
                      </button>
                      <p className="text-gray-400">
                        Only the address that created the campaign can Claim the campaign.<br />
                        The creator can claim the raised funds at any time when they are 100% or above the initial funding target.
                      </p>
                      
                      <button
                        disabled={campaignUTXO.token?.nft?.capability != 'minting'}
                        onClick={() => handleCancel(campaignUTXO.token?.nft?.commitment.substring(70,80) ?? "0")}
                        className="px-6 py-2 bg-red-500 rounded-full disabled:bg-gray-500 disabled:cursor-not-allowed hover:bg-red-600"
                      >
                        {cancelPending ? (
                          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
                        ) : (
                          'Cancel'
                        )}
                      </button>
                      <p className="text-gray-400">
                        Cancel an active campaign, preventing new pledges.<br/>
                        Only the address that created the campaign can Cancel the campaign.
                      </p>
                    </div>
                  )}
                </div>

                {/* Pledges Sidebar */}
                <div className="bg-gray-900 rounded-lg p-6">
                  <h3 className="text-lg font-semibold mb-6">Pledges</h3>
                  {!campaignInfo ? (
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#0AC18E] mx-auto" />
                  ) : (
                    <div className="space-y-4">
                      {campaignInfo.pledges.map((pledge, index) => (
                        <div key={index} className="bg-gray-800 rounded-lg p-4">
                          <div className="flex justify-between items-center mb-2">
                            <span className="font-medium truncate max-w-[200px]">{pledge.name}</span>
                            <div className="flex items-center gap-2">
                              <div 
                                className="h-5 w-5 bg-cover bg-center"
                                style={{ backgroundImage: `url(${BCHLogo})` }}
                              />
                              {pledge.amount}
                            </div>
                          </div>
                          <p className="text-gray-400 italic mb-2">"{pledge.message}"</p>
                          <div className="text-sm text-gray-500">#{pledge.pledgeID}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            </div>
          </div>
        )}

        {/* Campaign does not have a UTXO but campaign data exists on server */}
        {!campaignUTXO && campaignInfo && (
          <div className="max-w-6xl mx-auto p-4">
            {/* Banner and User Info */}
            <div className="flex flex-col">
              <div 
                className="w-full h-[200px] bg-cover bg-center rounded-t-lg"
                style={{ backgroundImage: `url(${campaignInfo.banner})` }}
              />
              <div className="flex items-center p-4 bg-black/50">
                {isLoading ? (
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#0AC18E]" />
                ) : (
                  <div className="flex items-center gap-3">
                    <div 
                      className="h-12 w-12 bg-cover bg-center rounded-full"
                      style={{ backgroundImage: `url(${campaignInfo.logo})` }}
                    />
                    <span className="font-medium">{campaignInfo.owner}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Campaign Title */}
            <h1 className="text-2xl font-bold text-center my-6">{campaignInfo.name}</h1>

            {/* Progress Bar */}
            <div className="relative w-full h-8 bg-gray-800 rounded-full mb-6">
              <div className="absolute inset-0 flex justify-center items-center">
                {pledgeTotal}
              </div>
              <div className="absolute left-0 top-0 h-full bg-[#0AC18E] rounded-full w-full" />
            </div>

            {/* Pledge Bar */}
            <div className="bg-gray-900 rounded-lg p-6 space-y-6">
              {/* Campaign Details Row */}
              <div className="relative flex justify-between items-center">
                <div className="absolute inset-0 bg-black/50" />
                <span className="relative z-10"><b>Campaign:</b>&nbsp;#{id}</span>
                {!isLoading && (
                  <>
                    <span className="relative z-10">
                      {campaignInfo.pledges.length > 0 && !isFailed ? 'Campaign Successful' : 'Campaign Failed'}
                    </span>
                    {endBlock != 0 && (
                      <span className="relative z-10"><b>End Block:</b>&nbsp;{endBlock}</span>
                    )}
                  </>
                )}
              </div>

              {/* Pledge Input Section */}
              <div className="relative space-y-4">
                <div className="absolute inset-0 bg-black/50" />
                <h3 className="relative z-10 text-lg font-semibold">Make a Pledge</h3>
                <div className="h-[15px]" />
                <div className="relative z-10 flex flex-col items-center gap-4">
                  <div 
                    className="h-10 w-10 bg-cover bg-center"
                    style={{ backgroundImage: `url(${BCHLogo})` }}
                  />
                  <input
                    type="text"
                    placeholder="Amount"
                    value={stringPledgeAmount}
                    onChange={(e) => handleSetPledgeAmount(e.target.value)}
                    className="bg-white text-black px-4 py-2 rounded-lg w-full"
                  />
                </div>
              </div>

              {/* NFTs Section */}
              <div className="relative space-y-4">
                <div className="absolute inset-0 bg-black/50" />
                <h3 className="relative z-10 text-lg font-semibold">See your Pledge</h3>
                <div className="relative z-10 flex justify-between items-center">
                  <button 
                    onClick={fetchReceiptNFTs}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-full"
                  >
                    Refresh
                  </button>
                </div>
                <div className="relative z-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {nfts.map((utxo, index) => (
                    <NFTItem key={index} utxo={utxo} />
                  ))}
                </div>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex border-b border-gray-700 mt-6">
              <button
                className={`px-6 py-3 ${selectedTab === 'Overview' ? 'border-b-2 border-[#0AC18E] text-[#0AC18E]' : 'text-gray-400 hover:text-gray-200'}`}
                onClick={() => handleSelectTab('Overview')}
              >
                Overview
              </button>
              <button
                className={`px-6 py-3 ${selectedTab === 'Updates' ? 'border-b-2 border-[#0AC18E] text-[#0AC18E]' : 'text-gray-400 hover:text-gray-200'}`}
                onClick={() => handleSelectTab('Updates')}
              >
                Updates
              </button>
              <div className="flex-grow" />
            </div>

            {/* Description and Links Container */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
              {/* Main Content */}
              <div className="lg:col-span-2 bg-gray-900 rounded-lg p-6">
                {selectedTab === 'Overview' && (
                  <div 
                    className="prose prose-invert max-w-none"
                    dangerouslySetInnerHTML={{ __html: campaignInfo.description }} 
                  />
                )}
                {selectedTab === 'Updates' && (
                  <div className="space-y-6 text-center">
                    {usersAddress == campaignInfo.ownersAddress && (
                      <>
                        {campaignInfo.isComplete != true && (
                          <>
                            <div className="flex items-center gap-2">
                              <input 
                                type="checkbox" 
                                checked={isComplete}
                                onChange={(e) => setIsComplete(e.target.checked)}
                                className="form-checkbox"
                              />
                              <label>The campaign is complete</label>
                            </div>
                            <input 
                              type="text"
                              value={urlAddress}
                              onChange={(e) => setUrlAddress(e.target.value)}
                              placeholder="Enter URL address..."
                              className="w-full px-4 py-2 bg-gray-800 rounded-lg"
                            />
                          </>
                        )}
                        RichTest Editor here
                        {/*<RichTextEditor isUpdate={true} value={updateText} onChange={setUpdateText} />*/}
                        <button 
                          onClick={handleSubmitUpdate}
                          className="px-6 py-2 bg-[#0AC18E] rounded-full hover:bg-[#0cd9a0]"
                        >
                          Submit Update
                        </button>
                      </>
                    )}
                    
                    {campaignInfo?.updates.length > 0 ? (
                      campaignInfo?.updates.map((update: any) => (
                        <div key={update.number} className="bg-gray-800 rounded-lg p-4 text-left">
                          <div className="font-semibold mb-2">Update #{update.number}</div>
                          <div 
                            className="prose prose-invert max-w-none"
                            dangerouslySetInnerHTML={{ __html: update.text }} 
                          />
                        </div>
                      ))
                    ) : (
                      'No updates have been posted by the creator yet.'
                    )}
                  </div>
                )}
              </div>

              {/* Pledges Sidebar */}
              <div className="bg-gray-900 rounded-lg p-6">
                <h3 className="text-lg font-semibold mb-6">Pledges</h3>
                {!campaignInfo ? (
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#0AC18E] mx-auto" />
                ) : (
                  <div className="space-y-4">
                    {campaignInfo.pledges.map((pledge, index) => (
                      <div key={index} className="bg-gray-800 rounded-lg p-4">
                        <div className="font-medium mb-2 truncate">{pledge.name}</div>
                        <p className="text-gray-400 italic mb-2">{pledge.message}</p>
                        <div className="flex justify-between items-center">
                          <div className="flex items-center gap-2">
                            <div 
                              className="h-5 w-5 bg-cover bg-center"
                              style={{ backgroundImage: `url(${BCHLogo})` }}
                            />
                            {pledge.amount}
                          </div>
                          <span className="text-sm text-gray-500">#{pledge.pledgeID}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Error State */}
        {fetchError && (
          <div className="text-center text-red-500 mt-8">
            Details for campaign #{id} were not found on the server
          </div>
        )}
      </div>
  );
}

export default CampaignDetail;