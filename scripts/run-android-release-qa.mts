import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHIPNET_SERVERS, rpc } from '../test-support/chipnetElectrum.ts';

export const CHIPNET_PUBLIC_BCMR_BASE_URLS = [
  'https://bcmr.optnlabs.com/api',
  'https://bcmr-chipnet.paytaca.com/api',
] as const;

export const CHIPNET_TOKENINDEXER_BASE_URL =
  'https://tokenindex.optnlabs.com/v1';
export const ANDROID_PACKAGE = 'optn.wallet.app';
export const DEFAULT_MAX_HEIGHT_LAG = 3;

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const defaultOutputRoot = path.join(projectRoot, '.qa', 'android-release');
const gateCommands = [
  ['deps:check', ['run', 'deps:check']],
  ['format:check', ['run', 'format:check']],
  ['typecheck:core', ['run', 'typecheck:core']],
  ['addons:validate', ['run', 'addons:validate']],
  ['security:test', ['run', 'security:test']],
  ['lint:core', ['run', 'lint:core']],
  ['test:core', ['run', 'test:core']],
  ['test:apps', ['run', 'test:apps']],
  ['test:ui', ['run', 'test:ui']],
  ['test:coverage', ['run', 'test:coverage']],
  ['build', ['run', 'build']],
  ['android:test', ['run', 'android:test']],
  ['android:test:instrumented', ['run', 'android:test:instrumented']],
  ['test:tooling', ['run', 'test:tooling']],
] as const;

type CommandResult = {
  command: string;
  exitCode: number;
  outputFile: string;
};

export type ElectrumProbe = {
  endpoint: string;
  ok: boolean;
  stale: boolean;
  latencyMs: number | null;
  height: number | null;
  serverVersion: string | null;
  error: string | null;
};

export type BcmrProbe = {
  endpoint: string;
  kind: 'bcmr' | 'tokenindexer';
  ok: boolean;
  status: number | null;
  hasMetadata: boolean | null;
  error: string | null;
};

type Options = {
  allowEndpointFailures: boolean;
  maxHeightLag: number;
  outputDir: string;
  requireClean: boolean;
  runGates: boolean;
  runInstrumented: boolean;
  skipDevice: boolean;
  skipEndpoints: boolean;
  tokenCategory: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    allowEndpointFailures: false,
    maxHeightLag: DEFAULT_MAX_HEIGHT_LAG,
    outputDir: '',
    requireClean: false,
    runGates: false,
    runInstrumented: false,
    skipDevice: false,
    skipEndpoints: false,
    tokenCategory: process.env.OPTN_QA_TOKEN_CATEGORY?.trim() ?? '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-endpoint-failures')
      options.allowEndpointFailures = true;
    else if (arg === '--require-clean') options.requireClean = true;
    else if (arg === '--run-gates') options.runGates = true;
    else if (arg === '--run-instrumented') options.runInstrumented = true;
    else if (arg === '--skip-device') options.skipDevice = true;
    else if (arg === '--skip-endpoints') options.skipEndpoints = true;
    else if (arg === '--max-height-lag') {
      options.maxHeightLag = Number(argv[++index]);
      if (!Number.isInteger(options.maxHeightLag) || options.maxHeightLag < 0) {
        throw new Error('--max-height-lag must be a non-negative integer');
      }
    } else if (arg === '--out') {
      options.outputDir = path.resolve(projectRoot, argv[++index]);
    } else if (arg === '--token-category') {
      options.tokenCategory = argv[++index]?.trim() ?? '';
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run android:qa:preflight -- [options]

Options:
  --run-gates                  Run the ordered local and Android test gates.
  --run-instrumented           Include connectedAndroidTest; use an isolated disposable device.
  --require-clean              Fail if the checkout has uncommitted changes.
  --token-category <category>  Probe public BCMR metadata for one category.
  --max-height-lag <blocks>    Stale endpoint threshold (default: ${DEFAULT_MAX_HEIGHT_LAG}).
  --allow-endpoint-failures    Record endpoint failures without failing the command.
  --skip-device                 Skip ADB/device inspection.
  --skip-endpoints              Skip public Electrum/BCMR probes.
  --out <directory>             Evidence directory relative to the repository.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function capture(command: string, args: string[] = []): string {
  try {
    return execFileSync(command, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const childError = error as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    return String(childError.stdout ?? childError.stderr ?? '').trim();
  }
}

function runCommand(
  label: string,
  command: string,
  args: string[],
  outputDir: string
): CommandResult {
  const outputFile = path.join(
    outputDir,
    `gate-${label.replace(/[^a-z0-9-]+/gi, '-')}.log`
  );
  console.log(`[android-qa] RUN ${label}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(outputFile, output);
  const exitCode = result.status ?? 1;
  console.log(`[android-qa] ${label}: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
  return { command: [command, ...args].join(' '), exitCode, outputFile };
}

function listConnectedDevices(): string[] {
  return capture('adb', ['devices'])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial);
}

function adb(serial: string, args: string[]): string {
  return capture('adb', ['-s', serial, ...args]);
}

function readDevice(serial: string) {
  const dumpsys = adb(serial, ['shell', 'dumpsys', 'package', ANDROID_PACKAGE]);
  return {
    serial,
    model: adb(serial, ['shell', 'getprop', 'ro.product.model']),
    androidVersion: adb(serial, [
      'shell',
      'getprop',
      'ro.build.version.release',
    ]),
    apiLevel: adb(serial, ['shell', 'getprop', 'ro.build.version.sdk']),
    resolution: adb(serial, ['shell', 'wm', 'size']),
    fontScale: adb(serial, [
      'shell',
      'settings',
      'get',
      'system',
      'font_scale',
    ]),
    package: ANDROID_PACKAGE,
    versionName: dumpsys.match(/versionName=([^\s]+)/)?.[1] ?? null,
    versionCode: dumpsys.match(/versionCode=(\d+)/)?.[1] ?? null,
    installed: dumpsys.includes(`Package [${ANDROID_PACKAGE}]`),
  };
}

function isRpcError(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'error' in value);
}

export async function probeElectrumServer(
  endpoint: string,
  timeoutMs = 12_000
): Promise<ElectrumProbe> {
  const started = performance.now();
  const response = await rpc(
    endpoint,
    [
      [1, 'server.version', ['optn-android-release-qa', '1.4']],
      [2, 'blockchain.headers.subscribe', []],
    ],
    timeoutMs
  );
  const version = response.results[1];
  const header = response.results[2];
  const height =
    header && typeof header === 'object' && 'height' in header
      ? Number((header as { height?: unknown }).height)
      : null;
  const validHeight = Number.isInteger(height) ? height : null;
  const ok =
    !response.err &&
    !isRpcError(version) &&
    !isRpcError(header) &&
    typeof version !== 'undefined' &&
    validHeight !== null;
  return {
    endpoint,
    ok,
    stale: false,
    latencyMs: Math.round(performance.now() - started),
    height: validHeight,
    serverVersion: Array.isArray(version)
      ? String(version[0] ?? '')
      : typeof version === 'string'
        ? version
        : null,
    error: ok ? null : response.err ?? 'invalid Electrum response',
  };
}

async function probeEndpoints(maxHeightLag: number): Promise<ElectrumProbe[]> {
  const probes: ElectrumProbe[] = [];
  for (const endpoint of CHIPNET_SERVERS) {
    try {
      probes.push(await probeElectrumServer(endpoint));
    } catch (error) {
      probes.push({
        endpoint,
        ok: false,
        stale: false,
        latencyMs: null,
        height: null,
        serverVersion: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const heights = probes
    .filter((probe) => probe.ok && probe.height !== null)
    .map((probe) => probe.height as number);
  const freshestHeight = heights.length > 0 ? Math.max(...heights) : null;
  for (const probe of probes) {
    probe.stale =
      freshestHeight !== null &&
      probe.height !== null &&
      freshestHeight - probe.height > maxHeightLag;
  }
  return probes;
}

async function fetchJson(
  url: string
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: { accept: 'application/json' },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function hasMetadata(body: unknown): boolean | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if ('bcmr' in value) return Boolean(value.bcmr);
  return Boolean(value.latest_revision || value.identity || value.name);
}

async function probeMetadata(category: string): Promise<BcmrProbe[]> {
  if (!category) return [];
  const requests = [
    ...CHIPNET_PUBLIC_BCMR_BASE_URLS.map((base) => ({
      endpoint: `${base}/registries/${encodeURIComponent(category)}/latest`,
      kind: 'bcmr' as const,
    })),
    {
      endpoint: `${CHIPNET_TOKENINDEXER_BASE_URL}/token/${encodeURIComponent(category)}`,
      kind: 'tokenindexer' as const,
    },
  ];
  const probes: BcmrProbe[] = [];
  for (const request of requests) {
    try {
      const response = await fetchJson(request.endpoint);
      probes.push({
        ...request,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        hasMetadata: hasMetadata(response.body),
        error: null,
      });
    } catch (error) {
      probes.push({
        ...request,
        ok: false,
        status: null,
        hasMetadata: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return probes;
}

function findFiles(
  root: string,
  predicate: (file: string) => boolean
): string[] {
  if (!statSync(root, { throwIfNoEntry: false })) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...findFiles(absolute, predicate));
    else if (predicate(absolute)) files.push(absolute);
  }
  return files;
}

function artifactReport() {
  const outputRoot = path.join(
    projectRoot,
    'android',
    'app',
    'build',
    'outputs'
  );
  return findFiles(
    outputRoot,
    (file) => /\.(apk|aab)$/.test(file) && /release|debug/.test(file)
  ).map((file) => ({
    path: path.relative(projectRoot, file),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    bytes: statSync(file).size,
  }));
}

function markdownReport(report: Record<string, unknown>): string {
  const probes = (report.endpoints ?? []) as ElectrumProbe[];
  const metadata = (report.metadata ?? []) as BcmrProbe[];
  const gates = (report.gates ?? []) as CommandResult[];
  const skippedGates = (report.skippedGates ?? []) as string[];
  return [
    '# Android release QA preflight',
    '',
    `Generated: ${report.generatedAt}`,
    `Revision: ${report.revision}`,
    `Branch: ${report.branch}`,
    `Checkout clean: ${report.checkoutClean}`,
    '',
    '## Device',
    '',
    '```json',
    JSON.stringify(report.device ?? null, null, 2),
    '```',
    '',
    '## Electrum endpoints',
    '',
    '| Endpoint | Result | Height | Status | Latency |',
    '| --- | --- | ---: | --- | ---: |',
    ...probes.map(
      (probe) =>
        `| ${probe.endpoint} | ${probe.ok ? 'connected' : `failed: ${probe.error ?? 'unknown'}`} | ${probe.height ?? '-'} | ${probe.stale ? 'stale' : 'fresh'} | ${probe.latencyMs ?? '-'} ms |`
    ),
    '',
    '## BCMR metadata',
    '',
    metadata.length === 0
      ? 'Not run: provide `--token-category <category>` to probe the public BCMR and TokenIndexer responses.'
      : metadata
          .map(
            (probe) =>
              `- ${probe.kind}: ${probe.endpoint} — ${probe.ok ? `HTTP ${probe.status}, metadata=${probe.hasMetadata}` : `failed (${probe.error ?? `HTTP ${probe.status}`})`}`
          )
          .join('\n'),
    '',
    '## Artifacts',
    '',
    ...(
      report.artifacts as { path: string; sha256: string; bytes: number }[]
    ).map(
      (artifact) =>
        `- \`${artifact.path}\` — ${artifact.bytes} bytes — SHA-256 \`${artifact.sha256}\``
    ),
    '',
    '## Automated gates',
    '',
    gates.length === 0
      ? 'Not run. Use `--run-gates` to execute the ordered repository and Android gates.'
      : gates
          .map(
            (gate) =>
              `- ${gate.exitCode === 0 ? 'PASS' : 'FAIL'} ${gate.command} — log: \`${path.relative(projectRoot, gate.outputFile)}\``
          )
          .join('\n'),
    skippedGates.length > 0
      ? `Skipped by safety policy: ${skippedGates.join(', ')}. Pass \`--run-instrumented\` only on an isolated disposable Android fixture.`
      : '',
    '',
    'Manual device flows remain separate evidence: onboarding, QR scan, send/review/broadcast, token/NFT, Custom Builder, Mint, Airdrops, Merchant Pay, Cauldron, history/explorer, retry/offline, and duplicate-activation checks.',
    '',
  ].join('\n');
}

export async function collectReleaseQa(options: Options) {
  const outputDir =
    options.outputDir ||
    path.join(
      defaultOutputRoot,
      new Date().toISOString().replace(/[:.]/g, '-')
    );
  mkdirSync(outputDir, { recursive: true });

  const status = capture('git', ['status', '--porcelain']);
  const checkoutClean = status.length === 0;
  if (options.requireClean && !checkoutClean) {
    throw new Error(
      'The checkout has uncommitted changes; release QA requires a clean candidate.'
    );
  }

  const devices = options.skipDevice ? [] : listConnectedDevices();
  if (!options.skipDevice && devices.length === 0) {
    throw new Error('No authorized Android device is connected through adb.');
  }
  const device = devices[0] ? readDevice(devices[0]) : null;
  const endpoints = options.skipEndpoints
    ? []
    : await probeEndpoints(options.maxHeightLag);
  const metadata = options.skipEndpoints
    ? []
    : await probeMetadata(options.tokenCategory);
  const gates = options.runGates
    ? gateCommands
        .filter(
          ([label]) =>
            label !== 'android:test:instrumented' || options.runInstrumented
        )
        .map(([label, args]) => runCommand(label, 'npm', args, outputDir))
    : [];
  const skippedGates =
    options.runGates && !options.runInstrumented
      ? ['android:test:instrumented']
      : [];
  const report = {
    generatedAt: new Date().toISOString(),
    revision: capture('git', ['rev-parse', 'HEAD']),
    branch: capture('git', ['branch', '--show-current']),
    checkoutClean,
    device,
    endpoints,
    metadata,
    artifacts: artifactReport(),
    gates,
    skippedGates,
  };
  writeFileSync(
    path.join(outputDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
  writeFileSync(path.join(outputDir, 'report.md'), markdownReport(report));
  writeFileSync(path.join(outputDir, 'git-status.txt'), `${status}\n`);
  console.log(
    `[android-qa] evidence: ${path.relative(projectRoot, outputDir)}`
  );

  const endpointFailure = endpoints.some((probe) => !probe.ok || probe.stale);
  const gateFailure = gates.some((gate) => gate.exitCode !== 0);
  return {
    report,
    outputDir,
    failed: gateFailure || (endpointFailure && !options.allowEndpointFailures),
  };
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  try {
    const result = await collectReleaseQa(parseArgs(process.argv.slice(2)));
    process.exitCode = result.failed ? 1 : 0;
  } catch (error) {
    console.error(
      `[android-qa] FAIL: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
