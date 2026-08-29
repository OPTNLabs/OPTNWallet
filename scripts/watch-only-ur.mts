/**
 * Chipnet watch-only PSBT UR tool. Same encoder as the GUI, no keys involved.
 *
 * The air-gap this serves is: OPTN builds an unsigned PSBT, shows it as an
 * animated QR, SeedCash reads it, signs, and shows the result back. This gives
 * that channel a command line, so the bytes can be produced, inspected and
 * checked without a camera in the loop.
 *
 *   encode   unsigned PSBT  -> UR frames
 *   decode   UR frames      -> PSBT
 *   verify   PSBT           -> per-input sighash report
 *   vectors  re-encode the committed vectors and compare
 *
 * Examples:
 *   npx tsx scripts/watch-only-ur.mts encode --network chipnet --in unsigned.psbt
 *   npx tsx scripts/watch-only-ur.mts encode --network chipnet --in unsigned.psbt --out-dir ./frames
 *   npx tsx scripts/watch-only-ur.mts decode --in ./frames/frame-01.ur ./frames/frame-02.ur
 *   npx tsx scripts/watch-only-ur.mts verify --in unsigned.psbt
 *   npx tsx scripts/watch-only-ur.mts vectors
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  decodePsbt,
  SIGHASH_ALL_FORKID_ANYONECANPAY,
} from '../src/services/psbt/psbtBch';
import {
  DEFAULT_UR_FRAGMENT_LENGTH,
  PSBT_UR_QR_MARGIN_MODULES,
  UrPsbtScanner,
} from '../src/services/psbt/urPsbt';
import {
  assertChipnetNetwork,
  assertWatchOnlySighash,
  encodeWatchOnlyUrFrames,
  parsePsbtBytes,
} from '../src/services/psbt/watchOnlyUrEncode';

const VECTORS = 'src/services/psbt/__tests__/vectors/watchOnlyUr.vectors.json';

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return undefined;
  const value = argv[index + 1];
  return value.startsWith('--') ? undefined : value;
}

/** Every value after `flag`, so a shell glob of frame files works. */
function argValues(argv: string[], flag: string): string[] {
  const index = argv.indexOf(flag);
  if (index === -1) return [];
  const values: string[] = [];
  for (let i = index + 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) break;
    values.push(argv[i]);
  }
  return values;
}

export class UsageError extends Error {}
export class CliFailure extends Error {}

export const USAGE =
  'Usage: tsx scripts/watch-only-ur.mts <command> [options]\n' +
  '\n' +
  '  encode  --network chipnet [--in <file>] [--out-dir <dir>]\n' +
  '          Unsigned PSBT (binary/hex/base64) -> UR frames at fragment\n' +
  `          length ${DEFAULT_UR_FRAGMENT_LENGTH}. Reads stdin when --in is absent.\n` +
  '  decode  [--in <file>...] [--out <file>]\n' +
  '          UR frames (one per line, or one per file) -> PSBT. Prints hex\n' +
  '          unless --out is given.\n' +
  '  verify  [--in <file>]\n' +
  '          Report PSBT_IN_SIGHASH_TYPE for every input. Exits non-zero\n' +
  '          unless every one is 0xc1.\n' +
  '  vectors [--file <path>]\n' +
  '          Re-encode the committed vectors and compare frame for frame.\n' +
  '\n' +
  `QR quiet zone for GUI display is ${PSBT_UR_QR_MARGIN_MODULES} modules; it is not a UR byte.\n` +
  'Chipnet only. Never reads keys or mnemonics.\n';

function readPsbt(inPath: string | undefined): Uint8Array {
  if (!inPath || inPath === '-') return parsePsbtBytes(fs.readFileSync(0));
  return parsePsbtBytes(fs.readFileSync(inPath));
}

/** UR frames from files, or from stdin, one per line. */
export function parseFrames(text: string): string[] {
  const frames = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (frames.length === 0) throw new CliFailure('no UR frames found');

  const stray = frames.find((frame) => !/^ur:/i.test(frame));
  if (stray) {
    const shown = stray.length > 40 ? `${stray.slice(0, 40)}…` : stray;
    throw new CliFailure(`not a UR frame: ${shown}`);
  }
  return frames;
}

/** Reassemble UR frames into the PSBT they carry. */
export function framesToPsbt(frames: string[]): Uint8Array {
  const scanner = new UrPsbtScanner();
  let progress = scanner.receive(frames[0]);
  for (let i = 1; i < frames.length && !progress.complete; i += 1) {
    progress = scanner.receive(frames[i]);
  }
  if (!progress.complete || !progress.psbt) {
    throw new CliFailure(
      `frames are incomplete (${Math.round(progress.progress * 100)}% decoded ` +
        `from ${frames.length} frame(s)); the set is missing parts`
    );
  }
  return progress.psbt;
}

export interface Vector {
  name: string;
  psbtHex: string;
  frameCount: number;
  frames: string[];
}

export interface VectorReport {
  name: string;
  matches: boolean;
  recordedFrames: number;
  producedFrames: number;
  /** 0-based index of the first differing frame, or -1. */
  firstDifference: number;
}

/**
 * Re-encode each vector and compare it to what was recorded.
 *
 * These are the exact bytes an air-gapped device reads. Drift is not cosmetic:
 * a change in the UR library, the fragment length or the CBOR shape changes
 * what every SeedCash sees, and the symptom is a camera that will not scan
 * rather than an exception anywhere.
 */
export function checkVectors(vectors: Vector[]): VectorReport[] {
  return vectors.map((vector) => {
    const psbt = Uint8Array.from(Buffer.from(vector.psbtHex, 'hex'));
    const produced = encodeWatchOnlyUrFrames(psbt);
    const firstDifference = produced.findIndex(
      (frame, index) => frame !== vector.frames[index]
    );
    return {
      name: vector.name,
      matches:
        produced.length === vector.frames.length && firstDifference === -1,
      recordedFrames: vector.frames.length,
      producedFrames: produced.length,
      firstDifference,
    };
  });
}

function encode(argv: string[], out: NodeJS.WritableStream): void {
  const network = argValue(argv, '--network') ?? 'chipnet';
  assertChipnetNetwork(network);

  const frames = encodeWatchOnlyUrFrames(readPsbt(argValue(argv, '--in')));
  const outDir = argValue(argv, '--out-dir');
  if (!outDir) {
    for (const frame of frames) out.write(`${frame}\n`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  // Zero-padded so a shell glob hands them back in order. decode does not
  // depend on the order, but a human reading the directory should not have to
  // sort them mentally.
  const width = String(frames.length).length;
  frames.forEach((frame, index) => {
    const name = `frame-${String(index + 1).padStart(width, '0')}.ur`;
    fs.writeFileSync(path.join(outDir, name), `${frame}\n`, 'utf8');
  });
  out.write(
    `wrote ${frames.length} UR frames to ${outDir} ` +
      `(fragment ${DEFAULT_UR_FRAGMENT_LENGTH})\n`
  );
}

function decode(argv: string[], out: NodeJS.WritableStream): void {
  const paths = argValues(argv, '--in');
  const text = paths.length
    ? paths.map((p) => fs.readFileSync(p, 'utf8')).join('\n')
    : fs.readFileSync(0, 'utf8');
  const psbt = framesToPsbt(parseFrames(text));

  const outPath = argValue(argv, '--out');
  if (outPath) {
    fs.writeFileSync(outPath, Buffer.from(psbt));
    out.write(`wrote ${psbt.length} PSBT bytes to ${outPath}\n`);
    return;
  }
  out.write(`${Buffer.from(psbt).toString('hex')}\n`);
}

function verify(argv: string[], out: NodeJS.WritableStream): void {
  const psbt = readPsbt(argValue(argv, '--in'));
  const parsed = decodePsbt(psbt);
  out.write(
    `${psbt.length} bytes, ${parsed.inputs.length} input(s), ` +
      `${parsed.outputs.length} output(s)\n`
  );

  parsed.inputs.forEach((input, index) => {
    const type = input.requestedSighashType;
    const shown = type === null ? 'absent' : `0x${type.toString(16)}`;
    const ok = type === SIGHASH_ALL_FORKID_ANYONECANPAY;
    out.write(`  input ${index}  sighash ${shown}  ${ok ? 'ok' : 'WRONG'}\n`);
  });

  try {
    assertWatchOnlySighash(psbt);
  } catch (error) {
    // SeedCash falls back to 0x41 when the field is absent, and a signature
    // over the wrong sighash is only rejected at broadcast — long after the
    // device has been put away.
    throw new CliFailure(
      error instanceof Error ? error.message : String(error)
    );
  }
  out.write('every input carries 0xc1 (ALL|FORKID|ANYONECANPAY)\n');
}

function vectors(argv: string[], out: NodeJS.WritableStream): void {
  const file = argValue(argv, '--file') ?? VECTORS;
  const document = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    vectors: Vector[];
  };
  if (!Array.isArray(document.vectors) || document.vectors.length === 0) {
    throw new CliFailure(`${file} contains no vectors`);
  }

  const reports = checkVectors(document.vectors);
  for (const report of reports) {
    if (report.matches) {
      out.write(`  ${report.name}: ok (${report.producedFrames} frames)\n`);
      continue;
    }
    out.write(`  ${report.name}: MISMATCH\n`);
    out.write(
      `    recorded ${report.recordedFrames} frame(s), ` +
        `produced ${report.producedFrames}\n`
    );
    if (report.firstDifference !== -1) {
      out.write(
        `    first difference at frame ${report.firstDifference + 1}\n`
      );
    }
  }

  const bad = reports.filter((report) => !report.matches).length;
  if (bad > 0) {
    throw new CliFailure(
      `${bad} vector(s) no longer match. If the change is intended, regenerate ` +
        'with scripts/generate-watch-only-ur-vectors.mts and say why.'
    );
  }
  out.write(`${reports.length} vector(s) match\n`);
}

export function run(
  argv: string[] = process.argv,
  out: NodeJS.WritableStream = process.stdout
): void {
  if (argv.includes('--help') || argv.includes('-h')) throw new UsageError();
  switch (argv[2]) {
    case 'encode':
      return encode(argv, out);
    case 'decode':
      return decode(argv, out);
    case 'verify':
      return verify(argv, out);
    case 'vectors':
      return vectors(argv, out);
    default:
      throw new UsageError();
  }
}

// Importing this from a test must not execute a command.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    run();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(USAGE);
      process.exit(2);
    }
    process.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
