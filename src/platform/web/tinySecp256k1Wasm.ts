import { SECP256K1_WASM_BASE64 } from './secp256k1WasmBase64.generated';

let instance: WebAssembly.Instance | undefined;
let initialization: Promise<WebAssembly.Instance> | undefined;

function generateInt32(): number {
  const bytes = new Uint8Array(4);
  if (typeof crypto === 'undefined') {
    throw new Error(
      'The crypto object is unavailable. This may occur if your environment does not support the Web Cryptography API.'
    );
  }
  crypto.getRandomValues(bytes);
  return (
    (bytes[0] << (3 * 8)) +
    (bytes[1] << (2 * 8)) +
    (bytes[2] << (1 * 8)) +
    bytes[3]
  );
}

const ERROR_MESSAGES: Record<number, string> = {
  0: 'Expected Private',
  1: 'Expected Point',
  2: 'Expected Tweak',
  3: 'Expected Hash',
  4: 'Expected Signature',
  5: 'Expected Extra Data (32 bytes)',
  6: 'Expected Parity (1 | 0)',
  7: 'Bad Recovery Id',
};

function throwError(errcode: number): void {
  throw new TypeError(
    ERROR_MESSAGES[errcode] ?? `Unknow error code: ${errcode}`
  );
}

export const tinySecp256k1Imports: WebAssembly.Imports = {
  './rand.js': { generateInt32 },
  './validate_error.js': { throwError },
};

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/**
 * Prepare tiny-secp256k1 before loading the application modules that consume
 * its synchronous API. WebViews reject synchronous compile and instantiate
 * calls for this module on the UI thread, but permit asynchronous instantiate.
 */
export function prepareTinySecp256k1Wasm(): Promise<WebAssembly.Instance> {
  if (instance) return Promise.resolve(instance);
  if (initialization) return initialization;

  initialization = WebAssembly.instantiate(
    decodeBase64(SECP256K1_WASM_BASE64),
    tinySecp256k1Imports
  )
    .then(({ instance: prepared }) => {
      instance = prepared;
      return prepared;
    })
    .catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });

  return initialization;
}

export function getPreparedTinySecp256k1Wasm():
  | WebAssembly.Instance
  | undefined {
  return instance;
}
