/**
 * Tiny local chat wrapper: two throwaway identities, no wallet UI.
 *
 *   npx tsx scripts/chat-cli.mts
 *   npx tsx scripts/chat-cli.mts dm
 *   npx tsx scripts/chat-cli.mts private
 *   npx tsx scripts/chat-cli.mts open
 *   npx tsx scripts/chat-cli.mts all --live
 *
 * Default is in-process (no relays). --live publishes to Paytaca/damus/nos.lol.
 * Does not print secret keys.
 */
import { dirname, join } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ledgerStub = pathToFileURL(
  join(here, 'ledger-hw-transport-stub.mts')
).href;
const idbStub = pathToFileURL(join(here, 'idb-keyval-stub.mts')).href;
const forageStub = pathToFileURL(join(here, 'localforage-stub.mts')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.includes('LedgerTransportNative') ||
      specifier.includes('@ledgerhq/hw-transport')
    ) {
      return { url: ledgerStub, shortCircuit: true, format: 'module' };
    }
    if (specifier === 'idb-keyval' || specifier.endsWith('/idb-keyval')) {
      return { url: idbStub, shortCircuit: true, format: 'module' };
    }
    if (specifier.includes('localforage')) {
      return { url: forageStub, shortCircuit: true, format: 'module' };
    }
    return nextResolve(specifier, context);
  },
});

const { runChatCli } = await import('./chat-cli-run.mts');
const code = await runChatCli(process.argv.slice(2));
process.exit(code);
