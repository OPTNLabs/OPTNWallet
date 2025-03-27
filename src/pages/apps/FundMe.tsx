import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { RootState } from '../../redux/store';
import ContractModal from '../../components/ContractModal';
import { Toast } from '@capacitor/toast';
import axios, { AxiosError } from 'axios';
import { Utxo } from 'cashscript';
import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';
import { AddressCashStarter, MasterCategoryID } from './utils/values';
import SignClient from '@walletconnect/sign-client'
import { WalletConnectModal } from '@walletconnect/modal';

interface ElectrumUtxo {
  height: number;
  token?: {
      amount: string;
      category: string;
      nft?: {
          capability: string;
          commitment: string;
      }
  };
  tx_hash: string;
  tx_pos: number;
  value: number;
}
interface ActionParameter {
    name: string;
    type: string;
    description: string;
    required: boolean;
}
interface AppAction {
    id: string;
    name: string;
    description: string;
    parameters: ActionParameter[];
    handler: (params: any) => Promise<void>;
}
interface CampaignUtxo extends ElectrumUtxo {
  name: string;
  owner: string;
  shortDescription: string;
  banner: string;
  endDate: string;
}
interface ArchivedCampaign {
  id: number;
  name: string;
  owner: string;
  shortDescription: string;
  banner: string;
  endDate: string;
}
const FundMeApp = () => {
  const [selectedAction, setSelectedAction] = useState<AppAction | null>(null);
  const [isActionModalOpen, setIsActionModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [totalCampaigns, setTotalCampaigns] = useState<number>(0);
  const [totalBCHRaised, setTotalBCHRaised] = useState<number>(0);
  const [totalPledges, setTotalPledges] = useState<number>(0);
  const [walletConnectInstance, setWalletConnectInstance] = useState<SignClient | null>(null);
  const [walletConnectSession, setWalletConnectSession] = useState<any>(null);
  const [connectedChain, setConnectedChain] = useState<string | null>('bch:bchtest');
  const [usersAddress, setUsersAddress] = useState<string | null>(null);
  const [isEmpty, setIsEmpty] = useState(false);
  const [campaigns, setCampaigns] = useState<ElectrumUtxo[]>([]);
  const [expiredCampaigns, setExpiredCampaigns] = useState<ElectrumUtxo[]>([]);
  const [campaignsMap, setCampaignsMap] = useState<Map<number, CampaignUtxo | null>>(new Map());
  const [expiredCampaignsMap, setExpiredCampaignsMap] = useState<Map<number, CampaignUtxo | null>>(new Map());
  const [archivedCampaignsMap, setArchivedCampaignsMap] = useState<Map<number, ArchivedCampaign | null>>(new Map());
  const [campaignType, setCampaignType] = useState<string>('active');
  //connectedChain: network === 'mainnet' ? 'bch:bitcoincash' : 'bch:bchtest' 

  const hexToDecimal = (hex: string): number => {
    const bigEndianHex = hex.match(/.{2}/g)?.reverse().join('') ?? '0';
    return parseInt(bigEndianHex, 16);
  };

  // Create an instance of ElectrumServer
  const electrumServer = ElectrumServer();


  useEffect(() => {
    async function fetchStats() {
      try {
        // Fetch stats from server
        const statsResponse = await axios.get('https://fundme.cash/get-stats');
        const statsData = statsResponse.data;
        
        // Set initial stats
        setTotalCampaigns(statsData.totalCampaigns);
        setTotalBCHRaised(statsData.totalRaisedBCH);
        setTotalPledges(statsData.totalPledges);

      } catch (error) {
        console.error('Error fetching stats:', error);
        Toast.show({
          text: `Error fetching stats:\n${error}`,
        });
      }
    }
    fetchStats();
  }, []);

//////////////////////////////////////////////////
////////// Prepare Wallet Connect Modal
//////////////////////////////////////////////////
  const walletConnectModal = new WalletConnectModal({
    projectId: '',
    themeMode: 'dark',
    themeVariables: {
      '--wcm-background-color': '#20c997',
      '--wcm-accent-color': '#20c997',
      },
    explorerExcludedWalletIds: 'ALL',
  });

  const requiredNamespaces = {
    bch: {
      chains: [connectedChain],
      methods: ['bch_getAddresses', 'bch_signTransaction', 'bch_signMessage'],
      events: ['addressesChanged'],
    },
  };  

////////////////////////////////////////////////// 
////////// Wallet Connect V2
//////////////////////////////////////////////////
  //connection settings
  const signClient = async () => {
    return await SignClient.init({
      projectId: '',
      // optional parameters
      relayUrl: 'wss://relay.walletconnect.com',
      metadata: {
        name: 'OPTN Wallet',
        description: 'OPTN Wallet',
        url: 'https://',
        icons: ['https://.png']
      }
    });
  } 

  //actual connect 
  const setupSignClient = async () => {
    console.log('setupSignClient(): starting');
    // Setup walletconnect client
    if (walletConnectInstance == null) {
      const client = await signClient();  //call connection with above settings, wait for instance response
      if (client != null) {

        // Set listeners on client then save client to state
        console.log('setupSignClient(): walletConnectInstance detected, adding listeners...')
        // Attach event listeners to client instance
        client.on('session_event', ( event ) => {
          console.log('session_event');
          console.log(event);
        });
        console.log('session_event added...');

        client.on('session_update', ({ topic, params }) => {
          console.log('session_update');
          console.log(params);
        });
        console.log('session_update added...');

        client.on('session_delete', () => {
          console.log('Deleting session with topic ' + walletConnectSession.topic);
          client.session.delete(
            walletConnectSession.topic,
            {
              code: 6000,
              message: "User Disconnected",
            })
            setUsersAddress('');
            //setBlockchainData({ usersAddress: '' });
        });
        console.log('session_delete added...');

        //setInstance(client);
        //setupSession(client);
        setWalletConnectInstance(client);
        //setBlockchainData({ instance: client });

       //check if session exists in localstorage to use
       console.log('setupSession(): checking for existing walletconnect session...')
       const lastKeyIndex = client.session.getAll().length - 1;
       const lastSession = client.session.getAll()[lastKeyIndex];

       if (lastSession) {
         console.log('setupSession(): session found in localstorage: ');
         console.log(lastSession);
         //setSession(lastSession);

         //set users saved address
         const existingSessionAddress = lastSession.namespaces['bch'].accounts[0].slice(4);
         console.log(existingSessionAddress);
         setUsersAddress(existingSessionAddress);
         //setBlockchainData({ session: lastSession, usersAddress: existingSessionAddress });
       }

    } 
  }
}
//////////////////////////////////////////////////
////////// User-triggered blockchain connect request
//////////////////////////////////////////////////
// Setup Session saved from localstorage
const manualSetupSignClient = async () => {
  console.log('manualSetupSignClient(): starting');

  // Setup walletconnect client
  let client: SignClient;
  if (walletConnectInstance == null) {
    console.log('manualSetupSignClient(): walletConnectInstance not detected, creating new instance...');
    client = await signClient();  //call connection with above settings, wait for instance response
    if (client != null) {

      // Set listeners on client then save client to state
      console.log('manualSetupSignClient(): walletConnectInstance detected, adding listeners...')
      // Attach event listeners to client instance
      client.on('session_event', ( event ) => {
        console.log('session_event');
        console.log(event);
      });
      console.log('session_event added...');

      client.on('session_update', ({ topic, params }) => {
        console.log('session_update');
        console.log(params);
      });
      console.log('session_update added...');

      client.on('session_delete', () => {
        console.log('Deleting session with topic ' + walletConnectSession.topic);
        client.session.delete(
          walletConnectSession.topic,
          {
            code: 6000,
            message: "User Disconnected",
          })
      });
      console.log('session_delete added...');
      setWalletConnectInstance(client);
      //setBlockchainData({ instance: client });
    } 
  }

  //load saved session or start a new one
  console.log('manualSetupSignClient(): checking for existing walletconnect session...');
  console.log(walletConnectInstance);
  const lastKeyIndex = walletConnectInstance.session.getAll().length - 1;
  const lastSession = walletConnectInstance.session.getAll()[lastKeyIndex];

  if (lastSession) {
    console.log('manualSetupSignClient(): session found in localstorage');
    setWalletConnectSession(lastSession);
    //setBlockchainData({ session: lastSession });

    //set users saved address
    const existingSessionAddress = lastSession.namespaces['bch'].accounts[0].slice(4);
    console.log(existingSessionAddress);
    setUsersAddress(existingSessionAddress);
    //setBlockchainData({ usersAddress: existingSessionAddress });

  //otherwise launch QR to start a new session
  } else {
    console.log('manualSetupSignClient(): no existing walletconnect session found, making a new one...');
    const { uri, approval } = await walletConnectInstance.connect({ requiredNamespaces });
    console.log('manualSetupSignClient(): uri received:');
    console.log(uri);
  
    // Open login window
    await walletConnectModal.openModal({ uri });
  
    // Await session approval from the wallet.
    console.log('manualSetupSignClient(): waiting for approval');
    const session = await approval();
    setWalletConnectSession(session);
    //setBlockchainData({ session: session });
    console.log('manualSetupSignClient(): WC connected! Session:');
    console.log(session);
    const existingSessionAddress = session.namespaces['bch'].accounts[0].slice(4);
    setUsersAddress(existingSessionAddress);
    //setBlockchainData({ usersAddress: existingSessionAddress });

    // Close the QRCode modal in case it was open.
    walletConnectModal.closeModal();
  }
}

const handleDisconnectWC = () => {
  console.log('handleDisconnectWC() started');
  try {
    if (walletConnectInstance && walletConnectSession) {
      walletConnectInstance?.disconnect({
        topic: walletConnectSession.topic,
        reason: {
          code: 6000,
          message: "User Disconnected",
        }
      });
  /*
      walletConnectInstance?.session.delete(
        walletConnectSession.topic,
        {
          code: 6000,
          message: "User Disconnected",
        });
  */
  console.log('attempting to delete item. localStorage length: ');
  console.log(localStorage.length);
  localStorage.clear();
  console.log(localStorage.length);

  console.log(localStorage.getItem(walletConnectSession.topic));

      localStorage.removeItem(walletConnectSession.topic);
      console.log('removing usersAddress');
      setUsersAddress('');
      //setBlockchainData({ usersAddress: '' });
      console.log('Wallet Disconnected');
    }

    let lastKeyIndex: number;
    let lastSession: any;

    if (walletConnectInstance) {
      console.log('walletConnectInstance exists')
      lastKeyIndex = walletConnectInstance.session.getAll().length - 1;
      lastSession = walletConnectInstance.session.getAll()[lastKeyIndex];
    } else if (walletConnectInstance) {
      console.log('instance exists')
      lastKeyIndex = walletConnectInstance.session.getAll().length - 1;
      lastSession = walletConnectInstance.session.getAll()[lastKeyIndex];
    }

    if (lastSession) {
      console.log('detected lastSession, deleting...')
      console.log('lastSession: ');
      console.log(lastSession);
      localStorage.removeItem(lastSession);
    }

  } catch (error) {
    console.log('Error disconnecting:', error);
  }
}

//////////////////////////////////////////////////
////////// Initialize Electrum, WalletConnect, userAddress
//////////////////////////////////////////////////
const initBlockchain = async () => {
  try {
    if (!walletConnectInstance) {
      console.log('initBlockchain(): 1. walletconnect NOT detected, do setupSignClient()');
      try {
        await setupSignClient();
      } catch (error) {
        console.error('initBlockchain(): Error setting up wallet connect:', error);
      }
    }
  } catch (error) {
    console.error('initBlockchain(): Error in blockchain initialization:', error);
  }
}
//////////////////////////////////////////////////
////////// UseEffect: Fetch campaigns on page load
//////////////////////////////////////////////////
useEffect(() => {
    setIsLoading(true);  //starts loading spinner graphic
    
    async function getCampaigns() {
      if (!electrumServer) return;

      //delay to allow electrum to stabilize
      setTimeout(async () => {
        //get full list of campaigns hosted on FundMe server
        const fetchedCampaigns = await axios.get('https://fundme.cash/get-campaignlist');
        let campaignList = fetchedCampaigns.data;

        //const cashStarterUTXOs: Utxo[] = await electrumServer.getUtxos(AddressCashStarter);
        //const cashStarterUTXOs: Utxo[] = await electrumServer.request('blockchain.address.listunspent', AddressCashStarter);
        const rawUTXOs = await electrumServer.request('blockchain.address.listunspent', AddressCashStarter) as any[];
        const transformedUTXOs = rawUTXOs.map(utxo => ({
          ...utxo,
          token: utxo.token_data
        }));
        console.log('[CashStarter] ' + transformedUTXOs.length + ' UTXOs');
        console.log('transformedUTXOs: ', transformedUTXOs);

        const filteredUTXOs = transformedUTXOs.filter( 
          utxo => utxo.token?.category == MasterCategoryID                  //only CashStarter NFT's
            && utxo.token?.nft?.capability == 'minting'                      //only minting ones
            && utxo.token.nft?.commitment.substring(70, 80) != 'ffffffffff' //not the masterNFT
        );

        console.log('[CashStarter] ' + filteredUTXOs.length + ' active campaigns');
        setCampaigns(filteredUTXOs);  //save active campaigns

        //if no utxos exist after filtering out the masterNFT
        if (filteredUTXOs.length == 0) {
          setIsLoading(false);
          setIsEmpty(true);
        }

        const expiredUTXOs = transformedUTXOs.filter(utxo => 
          utxo.token?.category === MasterCategoryID                       // only CashStarter NFT's
          && utxo.token?.nft?.capability === 'mutable'                    // expired ones
          && utxo.token.nft?.commitment.substring(70, 80) != 'ffffffffff' //not the masterNFT
        );
        console.log('[CashStarter] ' + expiredUTXOs.length + ' expired campaigns')
        setExpiredCampaigns(expiredUTXOs);  //save expired campaigns

        //Fill active map with active campaigns
        for (const utxo of filteredUTXOs) {                       //Iterate over filteredUTXOs to populate the map

          const campaignId = hexToDecimal(utxo.token?.nft?.commitment.substring(70,80) ?? "0");

          // Check if campaignId exists in the campaigns array
          const index = campaignList.indexOf(campaignId.toString());
          if (index !== -1) {
            // If found, remove it from the array
            campaignList.splice(index, 1);
          }

          const endBlock = hexToDecimal(utxo.token?.nft?.commitment.substring(52, 60) ?? "0");
          const endDate = await formatTime(endBlock);

          //fetch campaign metadata from server
          try {
            const response = await axios.get('https://fundme.cash/get-shortcampaign/' + campaignId);
            const campaignInfo = response.data;

            const newCampaign = {
              ...utxo,
              name: campaignInfo.name,
              owner: campaignInfo.owner,
              shortDescription: campaignInfo.shortDescription,
              banner: campaignInfo.banner,
              endDate: endDate
            };
          
            // Update the state with the new campaign
            setCampaignsMap((prevCampaignsMap) => {
              const updatedMap = new Map(prevCampaignsMap);
              updatedMap.set(campaignId, newCampaign);
              return updatedMap;
            });

          } catch (err) { //if server does not have the campaignId files hosted
            const error = err as AxiosError;
            if (error.response && error.response.status === 404) {
              console.log(`fetch error, campaign ${campaignId} not hosted on FundMe`);
            } else {
              console.log('fetch unknown error: ', err);
            }
          }
        };

        //Fill expired map with expired campaigns
        for (const utxo of expiredUTXOs) {                       //Iterate over expiredUTXOs to populate the map
          const campaignId = hexToDecimal(utxo.token?.nft?.commitment.substring(70,80) ?? "0");

            // Check if campaignId exists in the campaigns array
            const index = campaignList.indexOf(campaignId.toString());
            if (index !== -1) {
              // If found, remove it from the array
              campaignList.splice(index, 1);
            }
          const endBlock = hexToDecimal(utxo.token?.nft?.commitment.substring(52, 60) ?? "0");

          //fetch campaign metadata from server
          try {
            const response = await axios.get('https://fundme.cash/get-shortcampaign/' + campaignId);
            const campaignInfo = response.data;

            const expiredCampaign = {
              ...utxo,
              name: campaignInfo.name,
              owner: campaignInfo.owner,
              shortDescription: campaignInfo.shortDescription,
              banner: campaignInfo.banner,
              endDate: endBlock.toString()
            };
            
            // Update the state with the new campaign
            setExpiredCampaignsMap((prevExpiredCampaignsMap) => {
              const updatedMap = new Map(prevExpiredCampaignsMap);
              updatedMap.set(campaignId, expiredCampaign);
              return updatedMap;
            });

          } catch (err) { //if server does not have the campaignId files hosted
            const error = err as AxiosError;
            if (error.response && error.response.status === 404) {
              console.log(`fetch error, campaign ${campaignId} not hosted on FundMe`);
            } else {
              console.log('fetch unknown error: ', err);
            }
          }
        };

        //Fill archived map with archived campaigns
        for (const campaign of campaignList) {                       //Iterate over campaignList to populate the map
          //fetch campaign metadata from server
          try {
            const response = await axios.get('https://fundme.cash/get-shortcampaign/' + campaign);
            const campaignInfo = response.data;

            const archivedCampaign = {
              id: campaign,
              name: campaignInfo.name,
              owner: campaignInfo.owner,
              shortDescription: campaignInfo.shortDescription,
              banner: campaignInfo.banner,
              endDate: 'archived'
            };
            
            // Update the state with the new campaign
            setArchivedCampaignsMap((prevArchivedCampaignsMap) => {
              const updatedMap = new Map(prevArchivedCampaignsMap);
              updatedMap.set(campaign, archivedCampaign);
              return updatedMap;
            });

          } catch (err) { //if server does not have the campaignId files hosted
            const error = err as AxiosError;
            if (error.response && error.response.status === 404) {
              console.log(`fetch error, campaign ${campaign} not hosted on FundMe`);
            } else {
              console.log('fetch unknown error: ', err);
            }
          }
        };

        setIsLoading(false);
    }, 2000); // Delay of 2 seconds);
  }
    getCampaigns();

  }, []);

  const actions = [
    {
      id: 'create',
      name: 'Create Campaign',
      description: 'Create a new campaign',
      parameters: [/* ... */],
      handler: async (params) => {
        // Implementation
      }
    },
    // ... other actions
  ];

  const handleActionClick = (action: AppAction) => {
    setSelectedAction(action);
    setIsActionModalOpen(true);
  };

  const handleActionSubmit = async (params: any) => {
    if (!selectedAction) return;

    setIsLoading(true);
    setError(null);

    try {
      await selectedAction.handler(params);
      setIsActionModalOpen(false);
      await Toast.show({
        text: 'Action completed successfully!',
      });
    } catch (err: any) {
      setError(err.message);
      await Toast.show({
        text: 'Action failed: ' + err.message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  async function formatTime(blocks: number): Promise<string> {
    //const blockHeight = await electrumServer.getBlockHeight();
    const blockHeight = 900000;
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

  //click Details to open campaign details page
  const handleDetailsClick = (id: number) => {
    navigate(`/campaign/${id}`);
  };

  return (
    <div className="container mx-auto p-4">
        {/* Welcome Image */}
        <div className="flex justify-center mt-4">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="Welcome"
            className="max-w-full h-auto"
          />
        </div>

        {/* Connect Button */}
        {usersAddress ? (
                <>Connected: {usersAddress}</>
              ) : (
                <button onClick={manualSetupSignClient}>Connect</button>
            )}

        {/* Logo */}
        <div className="flex justify-center mt-4">
          <img
            src="/assets/images/fundme.png"
            alt="Welcome"
            className="max-w-full h-auto"
          />
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="p-4 bg-white rounded-lg shadow">
              <div className="text-sm text-gray-600">Past Campaigns</div>
              <div className="text-xl font-semibold mt-1">{totalCampaigns}</div>
          </div>
          
          <div className="p-4 bg-white rounded-lg shadow">
              <div className="text-sm text-gray-600">Active Campaigns</div>
              <div className="text-xl font-semibold mt-1">{campaigns.length}</div>
          </div>
          
          <div className="p-4 bg-white rounded-lg shadow">
              <div className="text-sm text-gray-600">Total Raised</div>
              <div className="flex items-center mt-1">
              <img src="/assets/images/bch-logo.png" alt="BCH" className="w-5 h-5 mr-2" />
              <span className="text-xl font-semibold">{totalBCHRaised.toFixed(2)}</span>
              </div>
          </div>
          
          <div className="p-4 bg-white rounded-lg shadow">
              <div className="text-sm text-gray-600">Total Pledges</div>
              <div className="text-xl font-semibold mt-1">{totalPledges}</div>
          </div>
        </div>

      <div className="flex justify-between items-center mb-6">
      <h1 className="text-2xl font-bold">FundMe</h1>
        <button
          onClick={() => navigate('/apps')}
          className="bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded"
        >
          Back to Apps
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {actions.map((action) => (
          <div
            key={action.id}
            onClick={() => handleActionClick(action)}
            className="p-4 border rounded-lg hover:bg-gray-50 cursor-pointer"
          >
            <h3 className="font-semibold">{action.name}</h3>
            <p className="text-sm text-gray-600">{action.description}</p>
          </div>
        ))}
      </div>

      {/* Fundme Campaigns */}
      <div className="flex gap-4 mb-6">
        <button 
          onClick={() => setCampaignType('active')} 
          className={`px-4 py-2 rounded-lg ${campaignType === 'active' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-700'}`}
        >
          Active
        </button>
        <button 
          onClick={() => setCampaignType('stopped')} 
          className={`px-4 py-2 rounded-lg ${campaignType === 'stopped' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-700'}`}
        >
          Stopped
        </button>
        <button 
          onClick={() => setCampaignType('archived')} 
          className={`px-4 py-2 rounded-lg ${campaignType === 'archived' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-700'}`}
        >
          Archived
        </button>
      </div>

      {isEmpty && campaignType === 'active' && (
        <h2 className="text-xl font-semibold text-gray-700 mb-4">No campaigns currently active.</h2>
      )}

      {campaignType === 'active' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...campaignsMap.values()].map((campaign) => (
            campaign && (
              <div 
                key={campaign.txid} 
                className="bg-gray-900 rounded-xl overflow-hidden border border-gray-700 shadow-[0_0_15px_rgba(0,0,0,0.2)] hover:shadow-[0_0_20px_rgba(10,193,142,0.3)] hover:border-[#0AC18E] transition-all duration-300">
                <div 
                  className="w-full max-w-[500px] aspect-[500/120] bg-cover bg-center mx-auto" 
                  style={{ backgroundImage: `url(${campaign.banner})` }}
                />
                <button 
                  disabled={campaign.shortDescription === 'Campaign pending listing approval'}
                  onClick={() => handleDetailsClick(hexToDecimal(campaign.token?.nft?.commitment.substring(70,80) ?? "0"))}
                  className="w-full py-2 bg-blue-500 text-white disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  Details
                </button>
                <div className="p-4">
                  <div className="relative h-6 bg-gray-200 rounded-full mb-2">
                    <div 
                      className="absolute left-0 top-0 h-full bg-blue-500 rounded-full"
                      style={{ width: `${(Number(campaign.value) / hexToDecimal(campaign.token?.nft?.commitment.substring(0, 12) ?? "0")) * 100}%` }}
                    />
                    <div className="absolute w-full text-center text-sm">
                      {((Number(campaign.value) / hexToDecimal(campaign.token?.nft?.commitment.substring(0, 12) ?? "0")) * 100).toFixed(2)}%
                    </div>
                    <div className="absolute w-full text-center text-xs mt-6">
                      {(Number(campaign.value) / 100000000)} / {(hexToDecimal(campaign.token?.nft?.commitment.substring(0, 12) ?? "0") / 100000000)}
                    </div>
                  </div>

                  <div className="flex justify-between items-center mb-3">
                    <h3 className="font-semibold text-lg">{campaign.name}</h3>
                    <p className="text-sm text-gray-600">Ends: <span className="font-medium">{campaign.endDate}</span></p>
                  </div>

                  <p className="text-gray-600 mb-4">{campaign.shortDescription}</p>

                  <div className="flex justify-between items-center text-sm text-gray-500">
                    <span>Campaign #{hexToDecimal(campaign.token?.nft?.commitment.substring(70,80) ?? "0")}</span>
                    <span>By: {campaign.owner}</span>
                  </div>
                </div>
              </div>
            )
          ))}

          {isLoading && (
            <div className="flex justify-center items-center">
              {/* Replace StyledSpinner with appropriate spinner component */}
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
            </div>
          )}
        </div>
      )}


      {/* Action Modal */}
      {isActionModalOpen && selectedAction && (
        <ContractModal
          action={selectedAction}
          onSubmit={handleActionSubmit}
          onClose={() => setIsActionModalOpen(false)}
          isLoading={isLoading}
          error={error}
        />
      )}
    </div>
  );
};

export default FundMeApp;