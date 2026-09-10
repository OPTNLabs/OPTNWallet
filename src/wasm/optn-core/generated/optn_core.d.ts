/* tslint:disable */
/* eslint-disable */

export function connectP2pkhLock(public_key: Uint8Array): Uint8Array;

export function connectPublicKey(private_key: Uint8Array): Uint8Array;

export function connectSignInput(context_json: string, private_key: Uint8Array, covered: Uint8Array, mode: number): Uint8Array;

export function connectSignP2pkh(context_json: string, private_key: Uint8Array, mode: number): Uint8Array;

export function connectSigningSerialization(context_json: string, covered: Uint8Array, mode: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly connectP2pkhLock: (a: number, b: number) => [number, number, number, number];
    readonly connectPublicKey: (a: number, b: number) => [number, number, number, number];
    readonly connectSignInput: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly connectSignP2pkh: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly connectSigningSerialization: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
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
