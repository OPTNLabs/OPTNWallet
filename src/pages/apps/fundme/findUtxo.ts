import { Utxo } from 'cashscript';

interface FindUTXOParams {
    utxos: Utxo[]
    minValue: bigint
  }

function findUTXO({ utxos, minValue }: FindUTXOParams) { 
    if (utxos.length === 0) {
        return "No UTXOs found in your wallet.";
    }
    
    //check for a fully valid utxo to use
    const validUtxos = utxos.filter( 
        utxo => !utxo.token && utxo.satoshis >= minValue,
    )
    if (validUtxos.length > 0) {        //return the first fully valid utxo
        return validUtxos[0];
    }
    
    //otherwise determine where the problem is
    const untokenizedUtxos = utxos.filter(utxo => !utxo.token);  //find utxos without tokens already configured
    if (untokenizedUtxos.length == 0) {
        return "Get a raw BCH utxo. Your wallet only contains tokenized utxos.";
    }
    const enoughSatoshisUtxos = utxos.filter(utxo => utxo.satoshis >= minValue);    //find utxos with enough satoshis
    if (enoughSatoshisUtxos.length == 0) {
        return "Get more untokenized sats or consolidate your utxos. Your wallet has no individual utxo with " + minValue + " or more satoshis on it.";
    }
    
    const enoughSatoshisSet = new Set(enoughSatoshisUtxos.map(utxo => utxo.txid));            // Create a Set for quick lookup of UTXOs that have enough satoshis
    const bothValidUtxos = untokenizedUtxos.filter(utxo => enoughSatoshisSet.has(utxo.txid)); // Filter untokenizedUtxos to keep only those that also have enough satoshis
    if (bothValidUtxos.length == 0) {
        return "Get more untokenized sats. Your wallet has no untokenized utxos with a high enough satoshi balance to cover " + minValue + "sats.";
    } else {
        return "Error: undefined findUTXO";
    }
}
  
export default findUTXO;