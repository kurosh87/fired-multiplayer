import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [
  spawn('npm', ['run','dev:server'], { cwd: root, stdio: 'inherit' }),
  spawn('npm', ['run','dev:web'], { cwd: root, stdio: 'inherit' }),
];
let stopping = false;
function stop(code) { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); process.exitCode = code; }
for (const child of children) {
  child.on('error', error => { process.stderr.write(`${error.message}\n`); stop(1); });
  child.on('exit', code => stop(code ?? 1));
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => stop(0));
