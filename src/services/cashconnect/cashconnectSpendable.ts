import {
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  type CompilationContextBch,
  type CompilationData,
  type CompilerBCH,
} from '@bitauth/libauth';
import type {
  ChangeTemplateDirective,
  TemplateDirective,
} from '@cashconnect-js/core/templates';
import {
  connectorP2pkhLock,
  connectorPublicKey,
  signConnectorP2pkh,
} from '../connect/ConnectSigningCore';

export function cashConnectChangeData(publicKey: Uint8Array) {
  return {
    bytecode: {
      'key.public_key': publicKey,
    },
  };
}

export function cashConnectSpendData(privateKey: Uint8Array) {
  return { keys: { privateKeys: { key: Uint8Array.from(privateKey) } } };
}

/**
 * Wallet-facing spendable coin. CashConnect's author will take lock/unlock/fee
 * instead of LibAuth compiler templates. We already compile that way here;
 * {@link toChangeTemplateDirective} / {@link toUnlockingDirective} are the
 * alpha.31 adapters and go away when the SDK matches this shape.
 */
export type UTXOSpendable = {
  lock: () => Uint8Array;
  unlock: (compilationContext?: CompilationContextBch) => Uint8Array;
  fee: number;
};

export type P2pkhUTXOSpendable = UTXOSpendable & {
  toUnlockingDirective: () => TemplateDirective;
  toChangeTemplateDirective: () => ChangeTemplateDirective;
};

const DEFAULT_CHANGE_FEE_SATS = 1000;

function compileScript(
  compiler: CompilerBCH,
  data: CompilationData<CompilationContextBch>,
  scriptId: 'lock' | 'unlock'
): Uint8Array {
  const result = compiler.generateBytecode({ data, scriptId });
  if (!result.success) {
    throw new Error(`CashConnect ${scriptId} compile failed`);
  }
  return result.bytecode;
}

export function createP2pkhUTXOSpendable(args: {
  privateKey: Uint8Array;
  publicKey?: Uint8Array;
  fee?: number;
}): P2pkhUTXOSpendable {
  const compiler = walletTemplateToCompilerBCH(walletTemplateP2pkhNonHd);
  const privateKey = Uint8Array.from(args.privateKey);
  const publicKey = connectorPublicKey(privateKey);
  if (
    args.publicKey &&
    (args.publicKey.length !== publicKey.length ||
      args.publicKey.some((byte, index) => byte !== publicKey[index]))
  ) {
    privateKey.fill(0);
    throw new Error('CashConnect public and private keys do not match');
  }
  // alpha.31 expects a compiler-shaped directive. Only that interface is
  // retained: the actual lock and transaction signature are produced in Rust.
  // No wallet private key is placed in the SDK's compilation-data object.
  const unlockData = cashConnectChangeData(publicKey);
  const lockData = cashConnectChangeData(publicKey);
  const generateBytecode = (({ data, debug, scriptId }) => {
    if (debug)
      throw new Error(
        'CashConnect Rust signer does not expose compiler debug data'
      );
    if (scriptId === 'lock') {
      return { success: true, bytecode: connectorP2pkhLock(publicKey) };
    }
    if (scriptId !== 'unlock' || !data.compilationContext) {
      throw new Error(
        'CashConnect signing requires the complete transaction context'
      );
    }
    return {
      success: true,
      bytecode: signConnectorP2pkh(data.compilationContext, privateKey),
    };
  }) as CompilerBCH['generateBytecode'];
  compiler.generateBytecode = generateBytecode;
  const fee = args.fee ?? DEFAULT_CHANGE_FEE_SATS;

  const directive = (script: 'lock' | 'unlock'): TemplateDirective => ({
    compiler,
    data: script === 'lock' ? lockData : unlockData,
    script,
  });

  return {
    lock: () => compileScript(compiler, lockData, 'lock'),
    unlock: (compilationContext) =>
      compileScript(
        compiler,
        compilationContext ? { ...unlockData, compilationContext } : unlockData,
        'unlock'
      ),
    fee,
    toUnlockingDirective: () => directive('unlock'),
    toChangeTemplateDirective: () => ({
      lock: directive('lock'),
      unlock: directive('unlock'),
      fee: BigInt(fee),
    }),
  };
}
