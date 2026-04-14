import {
  assertSuccess,
  binToHex,
  binsAreEqual,
  createVirtualMachineBch2026,
  flattenBinArray,
  hash256,
  importWalletTemplate,
  lockingBytecodeToCashAddress,
  numberToBinUint16BE,
  numberToBinUint32BE,
  range,
  secp256k1,
  sha256,
  walletTemplateToCompilerBCH,
} from '@bitauth/libauth';
import { Network } from '../redux/networkSlice';
import {
  deriveHdPrivateKeyAtPath,
  derivePrivateKeyAtPath,
  getBchAccountPath,
} from './HdWalletService';
import { zeroize } from '../utils/secureMemory';
import quantumrootTemplateJson from '../../../reference/quantumroot/quantumroot-schnorr-lm-ots-vault.json';
import type { QuantumrootVaultRecord } from '../types/types';

export const QUANTUMROOT_VARIABLE_PATH = {
  identifierSource: "0'",
  key: "1'",
  nonceSource: "2'",
  quantumPrivateKeySource: "3'",
} as const;

export type QuantumrootVariableName = keyof typeof QUANTUMROOT_VARIABLE_PATH;

export type QuantumrootDerivedComponent = {
  name: QuantumrootVariableName;
  path: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

export type QuantumrootLmOtsSignature = {
  C: Uint8Array;
  Y: Uint8Array[];
};

export type QuantumrootVaultArtifacts = {
  accountPath: string;
  addressIndex: number;
  accountHdPrivateKey: string;
  components: Record<QuantumrootVariableName, QuantumrootDerivedComponent>;
  quantumKeyIdentifier: Uint8Array;
  quantumSeed: Uint8Array;
  quantumPrivateKey: Uint8Array[];
  quantumPrivateKeyBytes: Uint8Array;
  quantumPublicKey: Uint8Array;
  receiveSchnorrPublicKey: Uint8Array;
};

export type QuantumrootCompiledVault = {
  receiveAddress: string;
  receiveLockingBytecode: Uint8Array;
  quantumLockAddress: string;
  quantumLockLockingBytecode: Uint8Array;
};

export type QuantumrootScenarioRequest = {
  scenarioId: string;
  unlockingScriptId: string;
};

const importedQuantumrootTemplate = importWalletTemplate(quantumrootTemplateJson);

if (typeof importedQuantumrootTemplate === 'string') {
  throw new Error(importedQuantumrootTemplate);
}

const quantumrootTemplate = importedQuantumrootTemplate;
const quantumrootCompiler = walletTemplateToCompilerBCH(quantumrootTemplate);

export function getQuantumrootTemplateWithOverrides(overrides?: {
  quantumPublicKey?: Uint8Array;
}) {
  if (!overrides?.quantumPublicKey) {
    return quantumrootTemplate;
  }

  return {
    ...quantumrootTemplate,
    scripts: {
      ...quantumrootTemplate.scripts,
      quantum_public_key: {
        ...quantumrootTemplate.scripts.quantum_public_key,
        script: `<0x${binToHex(overrides.quantumPublicKey)}>`,
      },
    },
  };
}

export function getQuantumrootComponentPath(
  network: Network,
  accountIndex: number,
  component: QuantumrootVariableName,
  addressIndex: number | bigint
): string {
  return `${getBchAccountPath(network, accountIndex)}/${QUANTUMROOT_VARIABLE_PATH[component]}/${addressIndex.toString()}`;
}

function getCashAddressPrefix(network: Network) {
  return network === Network.MAINNET ? 'bitcoincash' : 'bchtest';
}

export function deriveQuantumrootKeyIdentifier(
  identifierSourcePublicKey: Uint8Array
): Uint8Array {
  return Uint8Array.from(hash256(identifierSourcePublicKey).slice(0, 16));
}

export function deriveQuantumrootSeed(
  quantumPrivateKeySourcePublicKey: Uint8Array
): Uint8Array {
  return Uint8Array.from(hash256(quantumPrivateKeySourcePublicKey));
}

type LmOtsInstance = ReturnType<typeof instantiateLmOts>;

export function instantiateLmOts({
  baseW: w,
  hash,
}: {
  baseW: 1 | 2 | 4 | 8;
  hash: typeof sha256.hash;
}) {
  const n = hash(Uint8Array.of()).length;
  const u = Math.ceil((8 * n) / w);
  const v = Math.ceil((Math.floor(Math.log2(((1 << w) - 1) * u)) + 1) / w);
  const ls = 16 - v * w;
  const p = u + v;
  const D_PBLC = Uint8Array.of(0x80, 0x80);
  const D_MESG = Uint8Array.of(0x81, 0x81);
  const u32str = numberToBinUint32BE;
  const u16str = numberToBinUint16BE;

  const coef = (S: Uint8Array, i: number) => {
    if (w === 8) return S[i];
    const byteIdx = Math.floor((i * w) / 8);
    const offset = i % (8 / w);
    const shift = 8 - w * (offset + 1);
    return (S[byteIdx] >> shift) & ((1 << w) - 1);
  };

  const step = (
    data: Uint8Array,
    I: Uint8Array,
    q: number,
    i: number,
    j: number
  ) => hash(flattenBinArray([I, u32str(q), u16str(i), Uint8Array.of(j), data]));

  const checksum = (Q: Uint8Array) => {
    let sum = 0;
    for (const i of range(u)) sum += (1 << w) - 1 - coef(Q, i);
    return (sum << ls) & 0xffff;
  };

  const generatePrivateKey = (seed: Uint8Array, I: Uint8Array, q: number) =>
    range(p).map((i) =>
      hash(
        flattenBinArray([I, u32str(q), u16str(i), Uint8Array.of(0xff), seed])
      )
    );

  const derivePublicKey = (x: Uint8Array[], I: Uint8Array, q: number) => {
    const y = x.map((xi, i) => {
      let tmp = xi;
      for (const j of range((1 << w) - 1)) tmp = step(tmp, I, q, i, j);
      return tmp;
    });
    return hash(flattenBinArray([I, u32str(q), D_PBLC, ...y]));
  };

  const sign = (
    message: Uint8Array,
    x: Uint8Array[],
    I: Uint8Array,
    q: number,
    C: Uint8Array
  ) => {
    if (C.length !== n) throw new Error(`C must be ${n} bytes.`);
    const preImage = flattenBinArray([I, u32str(q), D_MESG, C, message]);
    const Q = hash(preImage);
    const sum = checksum(Q);
    const encodedMessageHash = flattenBinArray([Q, u16str(sum)]);
    const Y = x.map((xi, i) => {
      let tmp = xi;
      const steps = coef(encodedMessageHash, i);
      for (const j of range(steps)) tmp = step(tmp, I, q, i, j);
      return tmp;
    });
    return {
      checksum: sum,
      encodedMessageHash,
      preImage,
      Q,
      signature: { C, Y },
    };
  };

  const verify = (
    message: Uint8Array,
    sig: QuantumrootLmOtsSignature,
    I: Uint8Array,
    q: number,
    K: Uint8Array
  ) => {
    if (sig.C.length !== n) return false;

    const preImage = flattenBinArray([I, u32str(q), D_MESG, sig.C, message]);
    const Q = hash(preImage);
    const sum = checksum(Q);
    const encodedMessageHash = flattenBinArray([Q, u16str(sum)]);

    const z = sig.Y.map((Yi, i) => {
      let tmp = Yi;
      const startingStep = coef(encodedMessageHash, i);
      for (let j = startingStep; j < (1 << w) - 1; j += 1) {
        tmp = step(tmp, I, q, i, j);
      }
      return tmp;
    });

    const candidate = hash(flattenBinArray([I, u32str(q), D_PBLC, ...z]));
    return binsAreEqual(candidate, K);
  };

  return { checksum, coef, derivePublicKey, generatePrivateKey, sign, verify };
}

export const quantumrootLmOtsSha256n32w4: LmOtsInstance = instantiateLmOts({
  hash: sha256.hash,
  baseW: 4,
});

export function createQuantumrootMessageRandomizer(
  nonceSourcePublicKey: Uint8Array,
  serializationHash: Uint8Array
): Uint8Array {
  return Uint8Array.from(
    hash256(flattenBinArray([nonceSourcePublicKey, serializationHash]))
  );
}

export function deriveQuantumrootLmOtsArtifacts(
  quantumSeed: Uint8Array,
  quantumKeyIdentifier: Uint8Array,
  q = 0
) {
  const quantumPrivateKey = quantumrootLmOtsSha256n32w4.generatePrivateKey(
    quantumSeed,
    quantumKeyIdentifier,
    q
  );
  const quantumPublicKey = quantumrootLmOtsSha256n32w4.derivePublicKey(
    quantumPrivateKey,
    quantumKeyIdentifier,
    q
  );

  return {
    quantumPrivateKey,
    quantumPrivateKeyBytes: flattenBinArray(quantumPrivateKey),
    quantumPublicKey,
  };
}

export function signQuantumrootMessage(
  message: Uint8Array,
  quantumPrivateKey: Uint8Array[],
  quantumKeyIdentifier: Uint8Array,
  randomizer: Uint8Array,
  q = 0
) {
  return quantumrootLmOtsSha256n32w4.sign(
    message,
    quantumPrivateKey,
    quantumKeyIdentifier,
    q,
    randomizer
  );
}

export function verifyQuantumrootSignature(
  message: Uint8Array,
  signature: QuantumrootLmOtsSignature,
  quantumKeyIdentifier: Uint8Array,
  quantumPublicKey: Uint8Array,
  q = 0
) {
  return quantumrootLmOtsSha256n32w4.verify(
    message,
    signature,
    quantumKeyIdentifier,
    q,
    quantumPublicKey
  );
}

export async function deriveQuantumrootVaultArtifacts(
  network: Network,
  mnemonic: string,
  passphrase: string,
  accountIndex: number,
  addressIndex: number
): Promise<QuantumrootVaultArtifacts> {
  const accountPath = getBchAccountPath(network, accountIndex);
  const accountHdPrivateKey = await deriveHdPrivateKeyAtPath(
    mnemonic,
    passphrase,
    network,
    accountPath
  );
  const componentNames = Object.keys(
    QUANTUMROOT_VARIABLE_PATH
  ) as QuantumrootVariableName[];
  const components = {} as Record<QuantumrootVariableName, QuantumrootDerivedComponent>;

  for (const name of componentNames) {
    const path = getQuantumrootComponentPath(network, accountIndex, name, addressIndex);
    const privateKey = await derivePrivateKeyAtPath(mnemonic, passphrase, path);
    const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);

    if (typeof publicKey === 'string') {
      zeroize(privateKey);
      throw new Error(`Failed to derive compressed public key for ${name}: ${publicKey}`);
    }

    components[name] = {
      name,
      path,
      privateKey,
      publicKey: Uint8Array.from(publicKey),
    };
  }

  const quantumKeyIdentifier = deriveQuantumrootKeyIdentifier(
    components.identifierSource.publicKey
  );
  const quantumSeed = deriveQuantumrootSeed(
    components.quantumPrivateKeySource.publicKey
  );
  const { quantumPrivateKey, quantumPrivateKeyBytes, quantumPublicKey } =
    deriveQuantumrootLmOtsArtifacts(quantumSeed, quantumKeyIdentifier);

  return {
    accountPath,
    addressIndex,
    accountHdPrivateKey,
    components,
    quantumKeyIdentifier,
    quantumSeed,
    quantumPrivateKey,
    quantumPrivateKeyBytes,
    quantumPublicKey,
    receiveSchnorrPublicKey: Uint8Array.from(components.key.publicKey),
  };
}

function compileQuantumrootScript(
  scriptId: 'receive_address' | 'quantum_lock',
  accountHdPrivateKey: string,
  addressIndex: number,
  onlineQuantumSigner: '0' | '1',
  vaultTokenCategory: string,
  quantumPublicKey?: Uint8Array
): Uint8Array {
  const bytecodeVariables = {
    leaf_spend_index: '0',
    online_quantum_signer: onlineQuantumSigner,
    quantum_spend_index: '0',
    token_spend_index: '0',
    vault_token_category: vaultTokenCategory,
  } as unknown as Record<string, Uint8Array>;
  const compiler =
    scriptId === 'quantum_lock' && quantumPublicKey
      ? walletTemplateToCompilerBCH(
          getQuantumrootTemplateWithOverrides({ quantumPublicKey })
        )
      : quantumrootCompiler;
  const result = compiler.generateBytecode({
    scriptId,
    data: {
      hdKeys: {
        addressIndex,
        hdPrivateKeys: { owner: accountHdPrivateKey },
      },
      bytecode: bytecodeVariables,
    },
  });

  if (!result.success) {
    throw new Error(
      `Failed to compile Quantumroot script ${scriptId}: ${JSON.stringify(result)}`
    );
  }

  return Uint8Array.from(result.bytecode);
}

export function deriveQuantumrootVaultCompilation(
  network: Network,
  accountHdPrivateKey: string,
  addressIndex: number,
  onlineQuantumSigner: '0' | '1' = '0',
  vaultTokenCategory = '00'.repeat(32),
  quantumPublicKey?: Uint8Array
): QuantumrootCompiledVault {
  const prefix = getCashAddressPrefix(network);
  const receiveLockingBytecode = compileQuantumrootScript(
    'receive_address',
    accountHdPrivateKey,
    addressIndex,
    onlineQuantumSigner,
    vaultTokenCategory
  );
  const quantumLockLockingBytecode = compileQuantumrootScript(
    'quantum_lock',
    accountHdPrivateKey,
    addressIndex,
    onlineQuantumSigner,
    vaultTokenCategory,
    quantumPublicKey
  );
  const receiveAddress = lockingBytecodeToCashAddress({
    prefix,
    bytecode: receiveLockingBytecode,
  });
  const quantumLockAddress = lockingBytecodeToCashAddress({
    prefix,
    bytecode: quantumLockLockingBytecode,
  });

  if (typeof receiveAddress === 'string') {
    throw new Error(`Failed to encode Quantumroot receive address: ${receiveAddress}`);
  }
  if (typeof quantumLockAddress === 'string') {
    throw new Error(`Failed to encode Quantumroot lock address: ${quantumLockAddress}`);
  }

  return {
    receiveAddress: receiveAddress.address,
    receiveLockingBytecode,
    quantumLockAddress: quantumLockAddress.address,
    quantumLockLockingBytecode,
  };
}

export async function deriveQuantumrootVault(
  network: Network,
  mnemonic: string,
  passphrase: string,
  accountIndex: number,
  addressIndex: number,
  onlineQuantumSigner: '0' | '1' = '0',
  vaultTokenCategory = '00'.repeat(32)
) {
  const artifacts = await deriveQuantumrootVaultArtifacts(
    network,
    mnemonic,
    passphrase,
    accountIndex,
    addressIndex
  );
  const compiled = deriveQuantumrootVaultCompilation(
    network,
    artifacts.accountHdPrivateKey,
    addressIndex,
    onlineQuantumSigner,
    vaultTokenCategory,
    artifacts.quantumPublicKey
  );

  return {
    ...artifacts,
    ...compiled,
  };
}

export function toQuantumrootVaultRecord(
  walletId: number,
  accountIndex: number,
  vault: Awaited<ReturnType<typeof deriveQuantumrootVault>>,
  onlineQuantumSigner: 0 | 1 = 0,
  vaultTokenCategory = '00'.repeat(32)
): QuantumrootVaultRecord {
  const timestamp = new Date().toISOString();

  return {
    wallet_id: walletId,
    account_index: accountIndex,
    address_index: vault.addressIndex,
    receive_address: vault.receiveAddress,
    quantum_lock_address: vault.quantumLockAddress,
    receive_locking_bytecode: binToHex(vault.receiveLockingBytecode),
    quantum_lock_locking_bytecode: binToHex(vault.quantumLockLockingBytecode),
    quantum_public_key: binToHex(vault.quantumPublicKey),
    quantum_key_identifier: binToHex(vault.quantumKeyIdentifier),
    vault_token_category: vaultTokenCategory,
    online_quantum_signer: onlineQuantumSigner,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function generateQuantumrootReferenceScenario({
  scenarioId,
  unlockingScriptId,
}: QuantumrootScenarioRequest) {
  return assertSuccess(
    quantumrootCompiler.generateScenario({
      scenarioId,
      unlockingScriptId,
    })
  );
}

export function verifyQuantumrootReferenceScenario(request: QuantumrootScenarioRequest) {
  const scenario = generateQuantumrootReferenceScenario(request);
  const vm = createVirtualMachineBch2026();
  return vm.verify(scenario.program);
}

export function describeQuantumrootArtifacts(artifacts: QuantumrootVaultArtifacts) {
  return {
    accountPath: artifacts.accountPath,
    addressIndex: artifacts.addressIndex,
    componentPaths: Object.fromEntries(
      Object.entries(artifacts.components).map(([name, component]) => [
        name,
        component.path,
      ])
    ),
    quantumKeyIdentifier: binToHex(artifacts.quantumKeyIdentifier),
    quantumSeed: binToHex(artifacts.quantumSeed),
    quantumPublicKey: binToHex(artifacts.quantumPublicKey),
    receiveSchnorrPublicKey: binToHex(artifacts.receiveSchnorrPublicKey),
  };
}

export function zeroizeQuantumrootArtifacts(artifacts: QuantumrootVaultArtifacts) {
  for (const component of Object.values(artifacts.components)) {
    zeroize(component.privateKey);
  }
  for (const element of artifacts.quantumPrivateKey) {
    zeroize(element);
  }
  zeroize(artifacts.quantumPrivateKeyBytes);
}
