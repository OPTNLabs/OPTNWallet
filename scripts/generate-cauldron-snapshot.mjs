import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath =
  process.env.CAULDRON_SNAPSHOT_OUT ??
  resolve(
    repoRoot,
    'src/services/__tests__/fixtures/cauldron-live-snapshot.json'
  );
const tokenLimit = Number(process.env.CAULDRON_SNAPSHOT_TOKEN_LIMIT ?? '5');

const networks = [
  {
    network: 'mainnet',
    apiBase: 'https://indexer.riften.net/cauldron',
  },
  {
    network: 'chipnet',
    apiBase: 'https://indexer-chipnet.riften.net/cauldron',
  },
];

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Cauldron snapshot fetch failed (${response.status} ${response.statusText}) for ${url}: ${text.slice(0, 200)}`
    );
  }
  return JSON.parse(text);
}

async function selectMarket(baseUrl, tokens) {
  for (const token of tokens) {
    const tokenId = String(token.token_id ?? '').trim().toLowerCase();
    if (!tokenId) continue;

    const payload = await fetchJson(
      `${baseUrl}/pool/active?token=${encodeURIComponent(tokenId)}`
    );
    const active = Array.isArray(payload?.active) ? payload.active : [];
    if (active.length > 0) {
      return {
        tokenId,
        tokenRow: token,
        activePoolRows: active,
      };
    }
  }

  throw new Error(`No active Cauldron pools found at ${baseUrl}`);
}

async function buildNetworkSnapshot({ network, apiBase }) {
  const tokensPayload = await fetchJson(
    `${apiBase}/tokens/list_cached?limit=${tokenLimit}&offset=0&by=score&order=desc`
  );
  const topTokens = Array.isArray(tokensPayload)
    ? tokensPayload
    : Array.isArray(tokensPayload?.tokens)
      ? tokensPayload.tokens
      : [];

  if (topTokens.length === 0) {
    throw new Error(`No cached Cauldron tokens found at ${apiBase}`);
  }

  const market = await selectMarket(apiBase, topTokens);

  return {
    network,
    apiBase,
    topTokens,
    market,
  };
}

async function main() {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: 'https://indexer.riften.net/cauldron',
    networks: await Promise.all(networks.map(buildNetworkSnapshot)),
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`Wrote Cauldron snapshot to ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
