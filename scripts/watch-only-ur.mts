/**
 * Chipnet-only watch-only PSBT UR (file/stdout). Same encoder as the GUI.
 *
 * Reads an unsigned PSBT (already locked to PSBT_IN_SIGHASH_TYPE 0xc1).
 * Writes UR frames at fragment length 50. No keys, no mnemonics.
 *
 *   npx tsx scripts/watch-only-ur.mts encode --network chipnet --in unsigned.psbt
 *   npx tsx scripts/watch-only-ur.mts encode --network chipnet --in unsigned.psbt --out-dir ./ur-frames
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_UR_FRAGMENT_LENGTH,
  PSBT_UR_QR_MARGIN_MODULES,
} from '../src/services/psbt/urPsbt';
import {
  assertChipnetNetwork,
  encodeWatchOnlyUrFrames,
  parsePsbtBytes,
} from '../src/services/psbt/watchOnlyUrEncode';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function usage(): never {
  process.stderr.write(
    `Usage: tsx scripts/watch-only-ur.mts encode --network chipnet [--in <file>] [--out-dir <dir>]\n` +
      `  Reads unsigned PSBT from --in or stdin (binary/hex/base64).\n` +
      `  Writes UR frames (fragment ${DEFAULT_UR_FRAGMENT_LENGTH}) to stdout or --out-dir.\n` +
      `  QR quiet zone for GUI display is ${PSBT_UR_QR_MARGIN_MODULES} modules.\n` +
      `  Chipnet only. Does not read keys or mnemonics.\n`
  );
  process.exit(2);
}

function readInput(inPath: string | undefined): Uint8Array {
  if (!inPath || inPath === '-') {
    const buf = fs.readFileSync(0);
    return parsePsbtBytes(buf);
  }
  return parsePsbtBytes(fs.readFileSync(inPath));
}

function main(): void {
  const command = process.argv[2];
  if (command !== 'encode' || hasFlag('--help') || hasFlag('-h')) usage();

  const network = argValue('--network') ?? 'chipnet';
  assertChipnetNetwork(network);

  const frames = encodeWatchOnlyUrFrames(readInput(argValue('--in')));
  const outDir = argValue('--out-dir');
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const width = String(frames.length).length;
    frames.forEach((frame, index) => {
      const name = `frame-${String(index + 1).padStart(width, '0')}.ur`;
      fs.writeFileSync(path.join(outDir, name), `${frame}\n`, 'utf8');
    });
    process.stdout.write(
      `wrote ${frames.length} UR frames to ${outDir} (fragment ${DEFAULT_UR_FRAGMENT_LENGTH})\n`
    );
    return;
  }
  for (const frame of frames) {
    process.stdout.write(`${frame}\n`);
  }
}

main();
