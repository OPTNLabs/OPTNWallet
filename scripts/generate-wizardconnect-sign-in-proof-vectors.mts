// Regenerates test-vectors/wizardconnect-sign-in-proof.json, the oracle for
// the Rust sign-in proof core (crates/optn-core/src/sign_in_proof.rs) and for
// its TypeScript glue (src/services/wizardconnect/signInProof.ts).
//   npx tsx scripts/generate-wizardconnect-sign-in-proof-vectors.mts
//
// Everything here is built with @bitauth/libauth alone: HD derivation,
// transaction encoding, the signing serialization and the Schnorr signature.
// Every signed proof is run through libauth's BCH VM before it is written.
// Nothing comes from the wallet's own core, because a vector the code under
// test wrote would only prove it agrees with itself. Each `reason` is the
// specification of what the core must answer, not a recording of what it did.
//
// Requests are in the shape the core takes: the transaction as wire bytes
// and each source output reduced to what a proof constrains.
import { writeFileSync } from 'node:fs';
import {
  binToHex,
  createVirtualMachineBCH,
  deriveHdPath,
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPublicNode,
  encodeHdPublicKey,
  encodeTransaction,
  generateSigningSerializationBCH,
  hash160,
  hash256,
  lockingBytecodeToCashAddress,
  secp256k1,
  sha256,
  utf8ToBin,
  type CompilationContextBCH,
  type Transaction,
} from '@bitauth/libauth';

// ---- the format -------------------------------------------------------------
const OP_RETURN_TAG = 'WCPROOF';
const OUTPOINT_TAG = 'WizardConnect sign-in proof:';
const OUTPOINT_SEPARATOR = ':';
const VALUE = 1000n;
const VERSION = 2;
const LOCKTIME = 0;
const SEQUENCE = 0xffffffff;
const SIGHASH = 0x61;

const concat = (...parts: Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((part) => [...part]));
/** The shortest push of up to 255 bytes. */
const push = (data: Uint8Array) =>
  data.length <= 75 ? [data.length, ...data] : [0x4c, data.length, ...data];
const opReturn = (...pushes: Uint8Array[]) =>
  Uint8Array.from([0x6a, ...pushes.flatMap(push)]);
const outpointHash = (code: Uint8Array, domain: Uint8Array) =>
  sha256.hash(
    concat(utf8ToBin(OUTPOINT_TAG), code, utf8ToBin(OUTPOINT_SEPARATOR), domain)
  );
/** The outpoint of the format before the domain was bound: code alone. */
const legacyOutpointHash = (code: Uint8Array) =>
  sha256.hash(concat(utf8ToBin(OUTPOINT_TAG), code));
const p2pkh = (publicKey: Uint8Array) =>
  Uint8Array.from([0x76, 0xa9, 0x14, ...hash160(publicKey), 0x88, 0xac]);

function canonical(
  code: string,
  domain: string,
  lockingBytecode: Uint8Array
): Transaction {
  return {
    version: VERSION,
    locktime: LOCKTIME,
    inputs: [
      {
        outpointTransactionHash: outpointHash(
          utf8ToBin(code),
          utf8ToBin(domain)
        ),
        outpointIndex: 0,
        sequenceNumber: SEQUENCE,
        unlockingBytecode: new Uint8Array(0),
      },
    ],
    outputs: [
      {
        lockingBytecode: opReturn(
          utf8ToBin(OP_RETURN_TAG),
          utf8ToBin(code),
          utf8ToBin(domain)
        ),
        valueSatoshis: 0n,
      },
      { lockingBytecode, valueSatoshis: VALUE },
    ],
  };
}

// ---- the wallet: the public BIP39 test mnemonic ----------------------------
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ACCOUNT = "m/44'/145'/0'";
const BRANCH = { receive: 0, change: 1, defi: 7 } as const;
type PathName = keyof typeof BRANCH;

const master = deriveHdPrivateNodeFromBip39Mnemonic(MNEMONIC);
const xpubs = Object.fromEntries(
  (Object.keys(BRANCH) as PathName[]).map((name) => [
    name,
    encodeHdPublicKey({
      network: 'mainnet',
      node: deriveHdPublicNode(
        deriveHdPath(master, `${ACCOUNT}/${BRANCH[name]}`)
      ),
    }).hdPublicKey,
  ])
);

function keyAt(path: PathName, index: number) {
  const derivationPath = `${ACCOUNT}/${BRANCH[path]}/${index}`;
  const privateKey = deriveHdPath(master, derivationPath).privateKey;
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  return { derivationPath, privateKey, publicKey };
}

function address(prefix: 'bitcoincash' | 'bchtest', bytecode: Uint8Array) {
  const result = lockingBytecodeToCashAddress({ prefix, bytecode });
  if (typeof result === 'string') throw new Error(result);
  return result.address;
}

// ---- valid proofs -----------------------------------------------------------
/** A label of `length` characters that neither starts nor ends with a hyphen. */
const label = (length: number) =>
  `a${'1b-2c'.repeat(20).slice(0, length - 2)}z`.slice(0, length);
const LONGEST_DOMAIN = [63, 63, 63, 61].map(label).join('.');
if (LONGEST_DOMAIN.length !== 253) throw new Error('longest domain');

const proofCases: {
  name: string;
  code: string;
  domain: string;
  path: PathName;
  index: number;
}[] = [
  {
    name: 'a receive address',
    code: 'Session_abcdef-0123456789',
    domain: 'example.com',
    path: 'receive',
    index: 3,
  },
  {
    name: 'the shortest code and a single-label host, on a change address',
    code: '0123456789abcdef',
    domain: 'localhost',
    path: 'change',
    index: 0,
  },
  {
    name: 'the longest code and domain and the last non-hardened index, on a defi address',
    code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
    domain: LONGEST_DOMAIN,
    path: 'defi',
    index: 0x7fffffff,
  },
];

const consensusVm = createVirtualMachineBCH(false);
const standardVm = createVirtualMachineBCH(true);

const proofs = proofCases.map(({ name, code, domain, path, index }) => {
  const key = keyAt(path, index);
  const lockingBytecode = p2pkh(key.publicKey);
  const transaction = canonical(code, domain, lockingBytecode);
  const unsigned = encodeTransaction(transaction);
  const sourceOutputs = [{ lockingBytecode, valueSatoshis: VALUE }];
  const serialization = generateSigningSerializationBCH(
    { inputIndex: 0, sourceOutputs, transaction } as CompilationContextBCH,
    {
      coveredBytecode: lockingBytecode,
      signingSerializationType: Uint8Array.of(SIGHASH),
    }
  );
  const signature = secp256k1.signMessageHashSchnorr(
    key.privateKey,
    hash256(serialization)
  );
  if (typeof signature === 'string') throw new Error(signature);
  const signedTransaction: Transaction = {
    ...transaction,
    inputs: [
      {
        ...transaction.inputs[0],
        unlockingBytecode: Uint8Array.from([
          ...push(Uint8Array.from([...signature, SIGHASH])),
          ...push(key.publicKey),
        ]),
      },
    ],
  };
  const consensus = consensusVm.verify({
    transaction: signedTransaction,
    sourceOutputs,
  });
  if (consensus !== true) throw new Error(`${name}: VM rejected: ${consensus}`);
  return {
    name,
    code,
    domain,
    path,
    addressIndex: index,
    derivationPath: key.derivationPath,
    publicKey: binToHex(key.publicKey),
    lockingBytecode: binToHex(lockingBytecode),
    addresses: {
      mainnet: address('bitcoincash', lockingBytecode),
      chipnet: address('bchtest', lockingBytecode),
    },
    outpointHash: binToHex(transaction.inputs[0].outpointTransactionHash),
    opReturn: binToHex(transaction.outputs[0].lockingBytecode),
    unsigned: binToHex(unsigned),
    signed: binToHex(encodeTransaction(signedTransaction)),
    // Whether libauth's relay-policy VM accepts it too. A proof is never
    // relayed; a long domain takes the OP_RETURN past the data-carrier limit.
    standard:
      standardVm.verify({ transaction: signedTransaction, sourceOutputs }) ===
      true,
  };
});

// ---- requests ---------------------------------------------------------------
type Source = {
  valueSatoshis: string;
  lockingBytecode: string;
  token: boolean;
  contract: boolean;
  unlockingBytecode: string;
};
type CoreRequest = {
  transaction: string;
  sourceOutputs: Source[];
  inputPaths: unknown[];
  broadcast: boolean;
};
type Shape = {
  tx?: (tx: Transaction) => void;
  sources?: (sources: Source[]) => void;
  inputPaths?: unknown[];
  broadcast?: boolean;
};

const CODE = proofCases[0].code;
const DOMAIN = proofCases[0].domain;
const tag = utf8ToBin(OP_RETURN_TAG);
const codeBytes = utf8ToBin(CODE);
const domainBytes = utf8ToBin(DOMAIN);
const own = p2pkh(keyAt('receive', 3).publicKey);
const other = p2pkh(keyAt('receive', 4).publicKey);

/** The canonical request for the first proof, bent by `shape`. */
function request(shape: Shape = {}): CoreRequest {
  const tx = canonical(CODE, DOMAIN, own);
  shape.tx?.(tx);
  const sources: Source[] = [
    {
      valueSatoshis: VALUE.toString(),
      lockingBytecode: binToHex(own),
      token: false,
      contract: false,
      unlockingBytecode: '',
    },
  ];
  shape.sources?.(sources);
  return {
    transaction: binToHex(encodeTransaction(tx)),
    sourceOutputs: sources,
    inputPaths: shape.inputPaths ?? [[0, 'receive', 3]],
    broadcast: shape.broadcast ?? false,
  };
}

/** Another OP_RETURN, over the outpoint that statement would derive. */
const stating = (script: Uint8Array, outpoint: Uint8Array): Shape => ({
  tx: (tx) => {
    tx.inputs[0].outpointTransactionHash = outpoint;
    tx.outputs[0].lockingBytecode = script;
  },
});
const withCode = (code: string) =>
  stating(
    opReturn(tag, utf8ToBin(code), domainBytes),
    outpointHash(utf8ToBin(code), domainBytes)
  );
const withDomain = (domain: string | Uint8Array) => {
  const bytes = typeof domain === 'string' ? utf8ToBin(domain) : domain;
  return stating(
    opReturn(tag, codeBytes, bytes),
    outpointHash(codeBytes, bytes)
  );
};
const derived = outpointHash(codeBytes, domainBytes);

const REASON = {
  broadcast: 'a sign-in proof is never broadcast',
  inputs: 'a proof has exactly one (fake) input',
  outputs: 'a proof has exactly two outputs',
  opReturn: 'output 0 must be OP_RETURN <tag> <code> <domain>',
  code: 'invalid one-time code for WizardConnect sign-in',
  domain: 'invalid relying-party domain',
  inputPath: 'exactly one wallet input path, for input 0',
  addressPath: 'unsupported address path',
  addressIndex: 'invalid address index',
  outpoint: 'outpoint is not the derived fake outpoint',
  source: 'source output is not the fake proof input for this address',
  token: 'token data is not allowed',
  unlocked: 'input is already unlocked',
  notCanonical: 'transaction differs from the canonical proof',
};

const refusalCases: [string, string, Shape][] = [
  [
    'an extra real input',
    REASON.inputs,
    {
      tx: (tx) => {
        tx.inputs.push({
          ...tx.inputs[0],
          outpointTransactionHash: new Uint8Array(32).fill(9),
        });
      },
      sources: (sources) => {
        sources.push({ ...sources[0] });
      },
    },
  ],
  [
    'a real outpoint instead of the derived one',
    REASON.outpoint,
    {
      tx: (tx) => {
        tx.inputs[0].outpointTransactionHash = new Uint8Array(32).fill(1);
      },
    },
  ],
  [
    'a non-zero outpoint index',
    REASON.outpoint,
    {
      tx: (tx) => {
        tx.inputs[0].outpointIndex = 1;
      },
    },
  ],
  [
    'an outpoint derived for another domain',
    REASON.outpoint,
    {
      tx: (tx) => {
        tx.inputs[0].outpointTransactionHash = outpointHash(
          codeBytes,
          utf8ToBin('evil.example')
        );
      },
    },
  ],
  [
    'an outpoint derived from the code alone',
    REASON.outpoint,
    {
      tx: (tx) => {
        tx.inputs[0].outpointTransactionHash = legacyOutpointHash(codeBytes);
      },
    },
  ],
  [
    'a sequence number that is not final',
    REASON.notCanonical,
    {
      tx: (tx) => {
        tx.inputs[0].sequenceNumber = 0xfffffffe;
      },
    },
  ],
  [
    // As the SDK decoder reports it: with no unlocking script of its own, the
    // source output carries the one found on the input.
    'an input that already carries an unlocking script',
    REASON.source,
    {
      tx: (tx) => {
        tx.inputs[0].unlockingBytecode = Uint8Array.of(0x51);
      },
      sources: (sources) => {
        sources[0].unlockingBytecode = '51';
      },
    },
  ],
  [
    'an unlocked input whose source output claims an empty unlocking script',
    REASON.unlocked,
    {
      tx: (tx) => {
        tx.inputs[0].unlockingBytecode = Uint8Array.of(0x51);
      },
    },
  ],
  [
    'a tampered output value',
    REASON.notCanonical,
    {
      tx: (tx) => {
        tx.outputs[1].valueSatoshis = 999n;
      },
    },
  ],
  [
    'a value on the OP_RETURN output',
    REASON.notCanonical,
    {
      tx: (tx) => {
        tx.outputs[0].valueSatoshis = 1n;
        tx.outputs[1].valueSatoshis = 999n;
      },
    },
  ],
  [
    'output 1 paying a different address',
    REASON.notCanonical,
    {
      tx: (tx) => {
        tx.outputs[1].lockingBytecode = other;
      },
    },
  ],
  [
    'an extra output',
    REASON.outputs,
    {
      tx: (tx) => {
        tx.outputs.push({ ...tx.outputs[1], valueSatoshis: 0n });
      },
    },
  ],
  [
    'the two outputs in the other order',
    REASON.opReturn,
    {
      tx: (tx) => {
        tx.outputs.reverse();
      },
    },
  ],
  [
    'token data on an output',
    REASON.token,
    {
      tx: (tx) => {
        tx.outputs[1].token = {
          category: new Uint8Array(32).fill(4),
          amount: 1n,
        };
      },
    },
  ],
  [
    'token data on the source output',
    REASON.source,
    {
      sources: (sources) => {
        sources[0].token = true;
      },
    },
  ],
  [
    'a contract on the source output',
    REASON.source,
    {
      sources: (sources) => {
        sources[0].contract = true;
      },
    },
  ],
  [
    'an unlocking script on the source output',
    REASON.source,
    {
      sources: (sources) => {
        sources[0].unlockingBytecode = '51';
      },
    },
  ],
  [
    'a bigger source value',
    REASON.source,
    {
      sources: (sources) => {
        sources[0].valueSatoshis = '100000';
      },
    },
  ],
  [
    'a source output locked to a different address',
    REASON.source,
    {
      sources: (sources) => {
        sources[0].lockingBytecode = binToHex(other);
      },
    },
  ],
  [
    'a different version',
    REASON.notCanonical,
    {
      tx: (tx) => {
        tx.version = 1;
      },
    },
  ],
  [
    'a non-zero locktime',
    REASON.notCanonical,
    {
      tx: (tx) => {
        tx.locktime = 5;
      },
    },
  ],

  // The code.
  ['a malformed code', REASON.code, withCode('too short')],
  ['a code one character too short', REASON.code, withCode('0123456789abcde')],
  [
    'a code one character too long',
    REASON.code,
    withCode(`${proofCases[2].code}x`),
  ],
  [
    'a code with a character outside the alphabet',
    REASON.code,
    withCode('Session.abcdef-0123456789'),
  ],
  [
    'the code and the domain in the other order',
    REASON.code,
    stating(
      opReturn(tag, domainBytes, codeBytes),
      outpointHash(domainBytes, codeBytes)
    ),
  ],

  // The domain: the relying party the proof is for.
  [
    'no domain: the two-push form from before the domain was bound',
    REASON.opReturn,
    stating(opReturn(tag, codeBytes), legacyOutpointHash(codeBytes)),
  ],
  ['an empty domain', REASON.domain, withDomain('')],
  ['an uppercase domain', REASON.domain, withDomain('Example.com')],
  ['a domain with a scheme', REASON.domain, withDomain('https://example.com')],
  ['a domain with a port', REASON.domain, withDomain('example.com:443')],
  ['a domain with a path', REASON.domain, withDomain('example.com/login')],
  ['a domain with a user', REASON.domain, withDomain('user@example.com')],
  ['a domain with a trailing dot', REASON.domain, withDomain('example.com.')],
  ['a domain with an empty label', REASON.domain, withDomain('example..com')],
  ['a domain with a space', REASON.domain, withDomain('example .com')],
  ['a domain with an underscore', REASON.domain, withDomain('my_app.example')],
  [
    'a label that starts with a hyphen',
    REASON.domain,
    withDomain('-example.com'),
  ],
  [
    'a label that ends with a hyphen',
    REASON.domain,
    withDomain('example-.com'),
  ],
  ['a label of 64 characters', REASON.domain, withDomain(`${label(64)}.com`)],
  [
    'a domain of 254 bytes',
    REASON.domain,
    withDomain([63, 63, 63, 62].map(label).join('.')),
  ],
  ['an IPv4 address', REASON.domain, withDomain('192.168.1.10')],
  ['a domain that is not ASCII', REASON.domain, withDomain('exämple.com')],
  [
    'a domain that is not UTF-8',
    REASON.domain,
    withDomain(Uint8Array.from([...utf8ToBin('example'), 0xff, 0x2e, 0x63])),
  ],

  // The shape of the OP_RETURN.
  [
    'a fourth push after the domain',
    REASON.opReturn,
    stating(opReturn(tag, codeBytes, domainBytes, utf8ToBin('more')), derived),
  ],
  ['a tag with no code', REASON.opReturn, stating(opReturn(tag), derived)],
  [
    'a code pushed with OP_PUSHDATA1',
    REASON.notCanonical,
    stating(
      Uint8Array.from([
        0x6a,
        ...push(tag),
        0x4c,
        codeBytes.length,
        ...codeBytes,
        ...push(domainBytes),
      ]),
      derived
    ),
  ],
  [
    'a truncated push after the tag',
    REASON.opReturn,
    stating(Uint8Array.from([0x6a, ...push(tag), 40, 1, 2, 3]), derived),
  ],

  // The wallet's own address.
  [
    'an address that is not the one at the requested path',
    REASON.source,
    { inputPaths: [[0, 'receive', 4]] },
  ],
  [
    'a second input path',
    REASON.inputPath,
    {
      inputPaths: [
        [0, 'receive', 3],
        [1, 'receive', 3],
      ],
    },
  ],
  ['no input path', REASON.inputPath, { inputPaths: [] }],
  [
    'an input path for another input',
    REASON.inputPath,
    { inputPaths: [[1, 'receive', 3]] },
  ],
  [
    'an address path the wallet does not have',
    REASON.addressPath,
    { inputPaths: [[0, 'rpa', 3]] },
  ],
  [
    'a hardened address index',
    REASON.addressIndex,
    { inputPaths: [[0, 'receive', 0x80000000]] },
  ],
  ['broadcast: true', REASON.broadcast, { broadcast: true }],
];

const refusals = refusalCases.map(([name, reason, shape]) => ({
  name,
  reason,
  request: request(shape),
}));
const refusal = (name: string) => {
  const found = refusals.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no refusal named ${name}`);
  return found.request.transaction;
};

// ---- requests that do not claim to be a proof -------------------------------
const untagged = (script: Uint8Array): Shape => ({
  tx: (tx) => {
    tx.outputs[0].lockingBytecode = script;
  },
});
const unclaimedCases: [string, Shape][] = [
  ['an ordinary OP_RETURN', untagged(opReturn(utf8ToBin('ABC')))],
  [
    'another protocol tag (BSEDITOR)',
    untagged(
      opReturn(
        utf8ToBin('BSEDITOR'),
        utf8ToBin('0123456789abcdef0123456789abcdef')
      )
    ),
  ],
  ['a bare OP_RETURN', untagged(Uint8Array.of(0x6a))],
  [
    'a longer tag that only starts with WCPROOF',
    untagged(opReturn(utf8ToBin('WCPROOF2'), codeBytes, domainBytes)),
  ],
  [
    'the tag as the second push',
    untagged(opReturn(codeBytes, tag, domainBytes)),
  ],
  [
    // Not a claim, so it gets the payment screen. The broadcast guard below
    // still stops it.
    'the tag pushed with OP_PUSHDATA1',
    untagged(
      Uint8Array.from([
        0x6a,
        0x4c,
        tag.length,
        ...tag,
        ...push(codeBytes),
        ...push(domainBytes),
      ])
    ),
  ],
  [
    'a payment with no OP_RETURN',
    {
      tx: (tx) => {
        tx.outputs = [{ lockingBytecode: other, valueSatoshis: 800n }];
      },
    },
  ],
];
const unclaimed = unclaimedCases.map(([name, shape]) => ({
  name,
  request: request(shape),
}));
const unclaimedNamed = (name: string) => {
  const found = unclaimed.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no unclaimed request named ${name}`);
  return found.request.transaction;
};

// ---- the broadcast guard ----------------------------------------------------
// Anything built around a fake outpoint, of this format or the one before
// the domain was bound, must never reach the network.
const broadcastGuard: [string, string, boolean][] = [
  ['the unsigned proof', proofs[0].unsigned, true],
  ['the signed proof', proofs[0].signed, true],
  [
    'the proof beside an extra real input',
    refusal('an extra real input'),
    true,
  ],
  [
    'the proof with a fourth push after the domain',
    refusal('a fourth push after the domain'),
    true,
  ],
  [
    'the proof with a tampered output value',
    refusal('a tampered output value'),
    true,
  ],
  [
    'a two-push proof from before the domain was bound',
    refusal('no domain: the two-push form from before the domain was bound'),
    true,
  ],
  [
    'a domain over the outpoint derived from the code alone',
    refusal('an outpoint derived from the code alone'),
    true,
  ],
  [
    'the tag pushed with OP_PUSHDATA1 over the derived outpoint',
    unclaimedNamed('the tag pushed with OP_PUSHDATA1'),
    true,
  ],
  [
    'the tag over a real outpoint',
    refusal('a real outpoint instead of the derived one'),
    false,
  ],
  [
    'the tag over an outpoint derived for another domain',
    refusal('an outpoint derived for another domain'),
    false,
  ],
  ['a tag with no code', refusal('a tag with no code'), false],
  ['an ordinary OP_RETURN', unclaimedNamed('an ordinary OP_RETURN'), false],
  [
    'a payment with no OP_RETURN',
    unclaimedNamed('a payment with no OP_RETURN'),
    false,
  ],
];

const path = 'test-vectors/wizardconnect-sign-in-proof.json';
writeFileSync(
  path,
  `${JSON.stringify(
    {
      reference:
        'Written by scripts/generate-wizardconnect-sign-in-proof-vectors.mts with @bitauth/libauth 3.1.0-next.8 alone; nothing here comes from the wallet. Every signed proof was accepted by the libauth BCH VM under consensus rules, and `standard` records whether its relay-policy VM accepts it too. Each request is in the shape crates/optn-core/src/sign_in_proof.rs takes and each reason is what that module must answer. Keys come from the public BIP39 test mnemonic; never a wallet or network credential.',
      format: {
        opReturnTag: OP_RETURN_TAG,
        outpointTag: OUTPOINT_TAG,
        outpointSeparator: OUTPOINT_SEPARATOR,
        valueSatoshis: VALUE.toString(),
        version: VERSION,
        locktime: LOCKTIME,
        sequenceNumber: SEQUENCE,
        sighash: SIGHASH,
      },
      wallet: { mnemonic: MNEMONIC, accountPath: ACCOUNT, xpubs },
      proofs,
      refusals,
      unclaimed,
      broadcastGuard: broadcastGuard.map(
        ([name, transaction, signInProof]) => ({
          name,
          transaction,
          signInProof,
        })
      ),
    },
    null,
    2
  )}\n`
);
console.log(
  `wrote ${path}: ${proofs.length} proofs (standard: ${proofs
    .map((proof) => proof.standard)
    .join(
      ', '
    )}), ${refusals.length} refusals, ${unclaimed.length} unclaimed, ${broadcastGuard.length} guard cases`
);
