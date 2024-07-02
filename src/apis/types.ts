export type Address = {
    wallet_id: number;
    address: string;
    balance: number;
    hd_index: number;
    change_index: number;
    prefix: string;
};

export type UTXOs = {
    wallet_id: number;
    address: string;
    height: number;
    tx_hash: string;
    tx_pos: number;
    amount: number;
    prefix: string;
    private_key : Uint8Array;
}