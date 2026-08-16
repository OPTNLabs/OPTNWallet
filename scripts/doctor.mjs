import { spawnSync } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const commandName = isWindows ? 'where' : 'which';

function checkCommand(command, args = [], label = command, required = true) {
  const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8' });
  const found = result.status === 0;
  const marker = found ? '✓' : required ? '✗' : '–';
  console.log(
    `${marker} ${label}${found ? `: ${result.stdout.trim().split('\n')[0]}` : ''}`
  );
  return found || !required;
}

function checkExecutable(command, label, required = true) {
  return checkCommand(commandName, [command], label, required);
}

let ok = true;
console.log(`OPTN Wallet developer prerequisite check (${process.platform})`);
ok = checkCommand(process.execPath, ['--version'], 'Node.js') && ok;
ok = checkExecutable('npm', 'npm') && ok;
ok = checkExecutable('rustc', 'Rust compiler', false) && ok;
ok = checkExecutable('cargo', 'Cargo', false) && ok;

if (process.platform === 'linux') {
  ok = checkExecutable('pkg-config', 'pkg-config', false) && ok;
  ok =
    checkExecutable(
      'WebKitWebDriver',
      'WebKitWebDriver (desktop E2E)',
      false
    ) && ok;
  ok =
    checkCommand(
      'pkg-config',
      ['--exists', 'webkit2gtk-4.1'],
      'WebKitGTK 4.1',
      false
    ) && ok;
  ok =
    checkCommand('pkg-config', ['--exists', 'librsvg-2.0'], 'librsvg', false) &&
    ok;
}

ok = checkExecutable('java', 'Java (Android builds)', false) && ok;
ok = checkExecutable('adb', 'adb (Android device install)', false) && ok;

if (!ok) {
  console.error(
    '\nRequired developer prerequisites are missing. See docs/build-and-release.md.'
  );
  process.exit(1);
}

console.log(
  '\nDoctor check complete. Optional platform tools may be installed only when building that target.'
);
