// import ElectrumService from "./ElectrumServer/ElectrumServer";

// export interface TransactionStub {
//     txid: string;
//     hex: string;
//   }

// export default function TransactionManager() {
//     return {
//         sendTransaction
//     }
//     async function sendTransaction( tx_hex, ): Promise<boolean> {
//         const result = await Electrum.broadcastTransaction(tx_hex);
//         console.log('result', result);
//         const isSuccess = result === tx_hash;
//         // console.log('Transaction hash:', tx_hash);
//         console.log('Broadcast success:', isSuccess);
//         return isSuccess ? tx_hash : null;
//     }
    
// }