// /**
//  * ElectrumService.ts
//  *
//  * High-level wrapper around ElectrumServer that provides:
//  *  - Request helpers for UTXOs, balances, transactions
//  *  - Broadcasting transactions
//  *  - Subscriptions to addresses, blocks, transactions, double-spend proofs
//  *  - Unsubscribe helpers
//  *
//  * Uses type guards to validate Electrum responses.
//  * Designed to keep the rest of the app abstracted away from raw RPC calls.
//  */

// import ElectrumServer from '../apis/ElectrumServer/ElectrumServer';
// import { RequestResponse } from 'electrum-cash';
// import { TransactionHistoryItem, UTXO } from '../types/types';

// /**
//  * Type guard: checks if Electrum response is an array of UTXOs
//  */
// function isUTXOArray(response: RequestResponse): response is UTXO[] {
//   return (
//     Array.isArray(response) &&
//     response.every(
//       (item) => 'tx_hash' in item && 'height' in item && 'value' in item
//     )
//   );
// }

// /**
//  * Type guard: checks if Electrum response is an array of transaction history items
//  */
// function isTransactionHistoryArray(
//   response: RequestResponse
// ): response is TransactionHistoryItem[] {
//   return (
//     Array.isArray(response) &&
//     response.every((item) => 'tx_hash' in item && 'height' in item)
//   );
// }

// /**
//  * Type guard: checks if Electrum response is a string
//  * (typically used for transaction hashes or subscription statuses)
//  */
// function isStringResponse(response: RequestResponse): response is string {
//   return typeof response === 'string';
// }

// /**
//  * ElectrumService
//  *
//  * Provides high-level async methods for interacting with Electrum.
//  * Handles data transformation and validation via type guards.
//  */
// const ElectrumService = {
//   /**
//    * Get list of UTXOs for an address.
//    *
//    * @param address BCH address
//    * @returns {Promise<UTXO[]>} List of unspent outputs
//    */
//   async getUTXOs(address: string): Promise<UTXO[]> {
//     const server = ElectrumServer();
//     try {
//       const UTXOs: RequestResponse = await server.request(
//         'blockchain.address.listunspent',
//         address
//       );

//       if (isUTXOArray(UTXOs)) {
//         return UTXOs.map((utxo) => {
//           if (utxo.token_data) {
//             utxo.token = utxo.token_data;
//             delete utxo.token_data;
//           }
//           return utxo;
//         });
//       } else {
//         throw new Error('Invalid UTXO response format');
//       }
//     } catch (error) {
//       console.error('Error fetching UTXOs:', error);
//       return [];
//     }
//   },

//   /**
//    * Get balance (confirmed + unconfirmed) for an address.
//    *
//    * @param address BCH address
//    * @returns {Promise<number>} Total satoshi balance
//    */
//   async getBalance(address: string): Promise<number> {
//     const server = ElectrumServer();
//     try {
//       const response: any = await server.request(
//         'blockchain.address.get_balance',
//         address,
//         'include_tokens'
//       );

//       if (
//         response &&
//         typeof response.confirmed === 'number' &&
//         typeof response.unconfirmed === 'number'
//       ) {
//         return response.confirmed + response.unconfirmed;
//       } else {
//         throw new Error('Unexpected response format');
//       }
//     } catch (error) {
//       console.error('Error getting balance:', error);
//       return 0;
//     }
//   },

//   /**
//    * Broadcast a transaction to the network.
//    *
//    * @param txHex Raw transaction hex
//    * @returns {Promise<string>} Transaction hash if successful
//    */
//   async broadcastTransaction(txHex: string): Promise<string> {
//     const server = ElectrumServer();
//     try {
//       const txHash: RequestResponse = await server.request(
//         'blockchain.transaction.broadcast',
//         txHex
//       );

//       if (isStringResponse(txHash)) {
//         return txHash;
//       } else {
//         throw new Error('Invalid transaction hash response format');
//       }
//     } catch (error: any) {
//       console.error('Error broadcasting transaction:', error);
//       return error.message || 'Unknown error';
//     }
//   },

//   /**
//    * Fetch full transaction history for an address.
//    *
//    * @param address BCH address
//    * @returns {Promise<TransactionHistoryItem[] | null>}
//    */
//   async getTransactionHistory(
//     address: string
//   ): Promise<TransactionHistoryItem[] | null> {
//     const server = ElectrumServer();
//     try {
//       if (!address) {
//         throw new Error('Invalid address: Address cannot be undefined');
//       }

//       const history: RequestResponse = await server.request(
//         'blockchain.address.get_history',
//         address
//       );

//       if (isTransactionHistoryArray(history)) {
//         return history;
//       } else {
//         throw new Error('Invalid transaction history response format');
//       }
//     } catch (error) {
//       console.error('Error fetching transaction history:', error);
//       return null;
//     }
//   },

//   /**
//    * Fetch the latest block header (tip of the chain).
//    */
//   async getLatestBlock() {
//     const server = ElectrumServer();
//     try {
//       const block: RequestResponse = await server.request(
//         'blockchain.headers.get_tip'
//       );
//       return block;
//     } catch (error) {
//       console.error('Error fetching block:', error);
//       return null;
//     }
//   },

//   /**
//    * Subscribe to address updates (balance/history changes).
//    *
//    * @param address BCH address
//    * @param callback Called with new status string when address changes
//    */
//   async subscribeAddress(address: string, callback: (status: string) => void) {
//     const server = await ElectrumServer().electrumConnect();
//     try {
//       const status: RequestResponse = await server.request(
//         'blockchain.address.subscribe',
//         address
//       );

//       if (isStringResponse(status)) {
//         server.on('notification', (method: string, params: any[]) => {
//           if (
//             method === 'blockchain.address.subscribe' &&
//             params[0] === address
//           ) {
//             callback(params[1]);
//           }
//         });
//       } else {
//         throw new Error('Invalid subscription response format');
//       }
//     } catch (error) {
//       console.error('Error subscribing to address:', error);
//     }
//   },

//   /**
//    * Subscribe to new block headers.
//    *
//    * @param callback Called with new block header when tip updates
//    */
//   async subscribeBlockHeaders(callback: (header: any) => void) {
//     const server = await ElectrumServer().electrumConnect();
//     try {
//       await server.request('blockchain.headers.subscribe');

//       server.on('notification', (method: string, params: any[]) => {
//         if (method === 'blockchain.headers.subscribe') {
//           callback(params[0]);
//         }
//       });
//     } catch (error) {
//       console.error('Error subscribing to block headers:', error);
//     }
//   },

//   /**
//    * Subscribe to transaction confirmation updates.
//    *
//    * @param txHash Transaction hash
//    * @param callback Called with block height on confirmation change
//    */
//   async subscribeTransaction(
//     txHash: string,
//     callback: (height: number) => void
//   ) {
//     const server = await ElectrumServer().electrumConnect();
//     try {
//       const height: RequestResponse = await server.request(
//         'blockchain.transaction.subscribe',
//         txHash
//       );

//       if (typeof height === 'number') {
//         server.on('notification', (method: string, params: any[]) => {
//           if (
//             method === 'blockchain.transaction.subscribe' &&
//             params[0] === txHash
//           ) {
//             callback(params[1]);
//           }
//         });
//       } else {
//         throw new Error('Invalid transaction subscription response format');
//       }
//     } catch (error) {
//       console.error('Error subscribing to transaction:', error);
//     }
//   },

//   /**
//    * Subscribe to double-spend proofs for a transaction.
//    *
//    * @param txHash Transaction hash
//    * @param callback Called with double-spend proof object
//    */
//   async subscribeDoubleSpendProof(
//     txHash: string,
//     callback: (dsProof: any) => void
//   ) {
//     const server = await ElectrumServer().electrumConnect();
//     try {
//       await server.request('blockchain.transaction.dsproof.subscribe', txHash);

//       server.on('notification', (method: string, params: any[]) => {
//         if (
//           method === 'blockchain.transaction.dsproof.subscribe' &&
//           params[0] === txHash
//         ) {
//           callback(params[1]);
//         }
//       });
//     } catch (error) {
//       console.error('Error subscribing to double-spend proof:', error);
//     }
//   },

//   /**
//    * Unsubscribe from address updates.
//    *
//    * @param address BCH address
//    * @returns {Promise<boolean>} True if unsubscribed
//    */
//   async unsubscribeAddress(address: string): Promise<boolean> {
//     const server = await ElectrumServer().electrumConnect();
//     try {
//       const result: RequestResponse = await server.request(
//         'blockchain.address.unsubscribe',
//         address
//       );
//       return result === true;
//     } catch (error) {
//       console.error('Error unsubscribing from address:', error);
//       return false;
//     }
//   },

//   /** Unsubscribe from block header updates */
//   async unsubscribeBlockHeaders(): Promise<boolean> {
//     const server = await ElectrumServer().electrumConnect();
//     try {
//       const result: RequestResponse = await server.request(
//         'blockchain.headers.unsubscribe'
//       );
//       return result === true;
//     } catch (error) {
//       console.error('Error unsubscribing from block headers:', error);
//       return false;
//     }
//   },

//   /** Unsubscribe from transaction updates */
//   async unsubscribeTransaction(txHash: string): Promise<boolean> {
//     const server = await ElectrumServer().electrumConnect();
//     try {
//       const result: RequestResponse = await server.request(
//         'blockchain.transaction.unsubscribe',
//         txHash
//       );
//       return result === true;
//     } catch (error) {
//       console.error('Error unsubscribing from transaction:', error);
//       return false;
//     }
//   },

//   /** Unsubscribe from double-spend proof updates */
//   async unsubscribeDoubleSpendProof(txHash: string): Promise<boolean> {
//     const server = await ElectrumServer().electrumConnect();
//     try {
//       const result: RequestResponse = await server.request(
//         'blockchain.transaction.dsproof.unsubscribe',
//         txHash
//       );
//       return result === true;
//     } catch (error) {
//       console.error('Error unsubscribing from double-spend proof:', error);
//       return false;
//     }
//   },
// };

// export default ElectrumService;
