/* tslint:disable */
/* eslint-disable */

/**
 * Decode a cashcode or legacy paycode. Returns JSON, or throws with the
 * reason the code was rejected.
 */
export function decodeCashcode(code: string): string;

/**
 * Derive scan/spend private and compressed public keys in the shared core.
 *
 * The packed result is `scan_priv(32) || scan_pub(33) || spend_priv(32) ||
 * spend_pub(33)`. A fixed byte layout avoids serializing private keys into
 * JavaScript strings, which are immutable and cannot be wiped by the caller.
 */
export function deriveRpaKeys(mnemonic: string, passphrase: string, scan_path: string, spend_path: string): Uint8Array;

/**
 * Encode a scan/spend pair as a `cashcode:` string.
 *
 * `legacy` stamps the old `paycode:` prefix instead. Nothing in the wallet
 * passes it: it exists so tests and migration tooling can build the form that
 * must keep being accepted on input.
 */
export function encodeCashcode(scan_pubkey: Uint8Array, spend_pubkey: Uint8Array, network: string, prefix_bits: number, legacy?: boolean | null): string;

/**
 * Compressed one-shot nonce point published for a credential slot.
 */
export function fusionBlindIssuerNoncePoint(nonce: Uint8Array): Uint8Array;

/**
 * Compressed public key for an issuer's non-zero canonical round secret.
 */
export function fusionBlindIssuerPublicKey(secret: Uint8Array): Uint8Array;

/**
 * Sign one blinded challenge with caller-owned issuer secret and nonce.
 */
export function fusionBlindIssuerSign(secret: Uint8Array, nonce: Uint8Array, challenge: Uint8Array): Uint8Array;

/**
 * The 32-byte blinded challenge to send to the issuer. `a` and `b` must be
 * fresh uniform scalars from the caller's CSPRNG and must never be reused.
 *
 * There is no handle to keep: `fusionFinalizeBlindSignature` takes the same
 * five inputs again and rebuilds the request, so nothing on the JS side owns
 * Rust memory it would have to free.
 */
export function fusionBlindRequest(round_pubkey: Uint8Array, r_point: Uint8Array, message: Uint8Array, a: Uint8Array, b: Uint8Array): Uint8Array;

/**
 * Complete a blinded signature. Takes the same inputs the request was built
 * from plus the issuer's 32-byte response, and returns the 64-byte signature.
 * Always verifies before returning, so a cheating issuer is an error here
 * rather than a rejected signature later in the round.
 */
export function fusionFinalizeBlindSignature(round_pubkey: Uint8Array, r_point: Uint8Array, message: Uint8Array, a: Uint8Array, b: Uint8Array, issuer_response: Uint8Array): Uint8Array;

/**
 * Check packed 65-byte uncompressed commitments against one signed amount and
 * the sum of their nonces. Malformed points fail closed.
 */
export function fusionPedersenBalanceHolds(packed_commitments: Uint8Array, excess_fee: bigint, total_nonce: Uint8Array): boolean;

/**
 * The 65-byte uncompressed Pedersen commitment `amount*H + nonce*G`.
 */
export function fusionPedersenCommit(amount: bigint, nonce: Uint8Array): Uint8Array;

/**
 * The commitment for a signed amount: an input commits `+value-fee`, an output
 * `-value-fee`, a blank `0`.
 */
export function fusionPedersenCommitSigned(amount: bigint, nonce: Uint8Array): Uint8Array;

/**
 * The compressed nothing-up-my-sleeve generator H, for callers that check it.
 */
export function fusionPedersenH(): Uint8Array;

/**
 * Whether bytes are one non-zero canonical secp256k1 scalar.
 */
export function fusionScalarIsCanonical(bytes: Uint8Array): boolean;

/**
 * Add packed 32-byte non-zero canonical scalars modulo the group order.
 */
export function fusionScalarSum(packed: Uint8Array): Uint8Array;

/**
 * Verify a 64-byte BCH Schnorr signature. False on any malformed input.
 */
export function fusionVerifySchnorr(pubkey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean;

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
    readonly deriveRpaKeys: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly encodeCashcode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly fusionBlindIssuerNoncePoint: (a: number, b: number) => [number, number, number, number];
    readonly fusionBlindIssuerPublicKey: (a: number, b: number) => [number, number, number, number];
    readonly fusionBlindIssuerSign: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly fusionBlindRequest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly fusionFinalizeBlindSignature: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly fusionPedersenBalanceHolds: (a: number, b: number, c: bigint, d: number, e: number) => [number, number, number];
    readonly fusionPedersenCommit: (a: bigint, b: number, c: number) => [number, number, number, number];
    readonly fusionPedersenCommitSigned: (a: bigint, b: number, c: number) => [number, number, number, number];
    readonly fusionPedersenH: () => [number, number];
    readonly fusionScalarIsCanonical: (a: number, b: number) => number;
    readonly fusionScalarSum: (a: number, b: number) => [number, number, number, number];
    readonly fusionVerifySchnorr: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
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
