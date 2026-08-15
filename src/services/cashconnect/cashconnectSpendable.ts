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
  const unlockData = cashConnectSpendData(args.privateKey);
  const lockData = args.publicKey
    ? cashConnectChangeData(args.publicKey)
    : unlockData;
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
        compilationContext
          ? { ...unlockData, compilationContext }
          : unlockData,
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
