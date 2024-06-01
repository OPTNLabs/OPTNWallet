import { hexToBin } from "@bitauth/libauth";
import KeyManager from "./KeyManager";

const KeyManage = KeyManager();

export default function WalletManager() {
    return {
        createInputs,
    };

    function createInputs(inputs: any, compiler) {
        const transactionInputs = inputs.map((input) => ({
            outpointTransactionHash: hexToBin(input.tx_hash),
            outpointIndex: input.tx_pos,
            sequenceNumber: 0,
            unlockingBytecode: {
                compiler,
                script: "unlock",
                valueSatoshis: BigInt(input.value),
                data: {
                    keys: {
                    privateKeys: {
                        key: KeyManage.fetchAddressPrivateKey(input.address),
                },
            },
            },
        },
    }));
    return transactionInputs;
    }
}
