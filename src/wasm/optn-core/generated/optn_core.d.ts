/* tslint:disable */
/* eslint-disable */

/**
 * Decode a cashcode or legacy paycode. Returns JSON, or throws with the
 * reason the code was rejected.
 */
export function decodeCashcode(code: string): string;

/**
 * Encode a scan/spend pair as a `cashcode:` string.
 *
 * `legacy` stamps the old `paycode:` prefix instead. Nothing in the wallet
 * passes it: it exists so tests and migration tooling can build the form that
 * must keep being accepted on input.
 */
export function encodeCashcode(scan_pubkey: Uint8Array, spend_pubkey: Uint8Array, network: string, prefix_bits: number, legacy?: boolean | null): string;

/**
 * The hex a sender grinds the input hash to match.
 */
export function grindString(scan_pubkey: Uint8Array, prefix_bits: number): string;

/**
 * True if the string carries any RPA prefix, cashcode or legacy paycode.
 */
export function looksLikeRpa(candidate: string): boolean;

/**
 * The one-time P2PKH a sender pays: CKD_pub of the spend key, hashed
 * compressed.
 */
export function paymentAddress(spend_pubkey: Uint8Array, secret: Uint8Array, network: string, index: number): string;

/**
 * `m/44'/<coin>'/<account>'/3/0` and `/3/1`, as a JSON object.
 */
export function rpaKeyPaths(coin_type: number, account: number): string;

/**
 * Payments to this wallet inside one raw transaction, as a JSON array.
 *
 * Takes `scanPrivkey` and `spendPubkey` only -- the spend private key is not
 * needed to find a payment, and requiring it here would destroy the split the
 * spec asks for (REQ-5) between detecting and spending.
 */
export function scanTransaction(raw_tx: Uint8Array, scan_privkey: Uint8Array, spend_pubkey: Uint8Array, network: string): string;

/**
 * Why this code must not be paid on-chain, or `undefined` if it may be.
 */
export function sendBlockReason(code: string): string | undefined;

/**
 * ECDH plus the outpoint, per the reference implementation. `txid` is the
 * display (big-endian) form, as block explorers show it.
 */
export function sharedSecret(privkey: Uint8Array, counterpart_pubkey: Uint8Array, txid: string, vout: number): Uint8Array;

/**
 * The private key that spends a payment at `index`.
 */
export function spendingKey(spend_privkey: Uint8Array, secret: Uint8Array, index: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly decodeCashcode: (a: number, b: number) => [number, number, number, number];
    readonly encodeCashcode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly grindString: (a: number, b: number, c: number) => [number, number, number, number];
    readonly looksLikeRpa: (a: number, b: number) => number;
    readonly paymentAddress: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly rpaKeyPaths: (a: number, b: number) => [number, number];
    readonly scanTransaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly sendBlockReason: (a: number, b: number) => [number, number, number, number];
    readonly sharedSecret: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly spendingKey: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
