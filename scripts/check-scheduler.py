#!/usr/bin/env python3
"""Exercise real frame coroutine suspension and fresh-instance restoration."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'


def main():
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve())]).returncode
    compiler = os.environ.get('KANTO_WASM_CC') or ('/opt/homebrew/opt/llvm/bin/clang'
                if Path('/opt/homebrew/opt/llvm/bin/clang').exists() else 'clang')
    target = ROOT / 'build/scheduler-test'
    target.mkdir(parents=True, exist_ok=True)
    fixture = target / 'fixture.c'
    fixture.write_text('''#include "kanto_scheduler.h"
static unsigned value, frames, buttons;
void KantoPlatformFrameBegin(void) {}
void KantoPlatformFrameEnd(void) { frames++; }
__attribute__((noinline)) unsigned nested(volatile unsigned *local) {
    for (unsigned i=0;i<3;i++) { KantoYieldFrame(); *local += buttons+i; }
    return *local;
}
typedef unsigned (*Callback)(volatile unsigned *, unsigned);
volatile Callback callback = (Callback)nested;
void KantoGameFrame(void) {
    volatile unsigned local[512];
    for(unsigned i=0;i<512;i++) local[i]=i+value;
    value=callback(&local[37],99); /* ARM-compatible extra argument. */
    for(unsigned i=0;i<512;i++) if(i!=37 && local[i] != i+local[0]) __builtin_trap();
    KantoYieldFrame();
}
void init(void) { KantoSchedulerInit(); }
int step(unsigned keys) { buttons=keys; return KantoSchedulerStep(); }
unsigned result(void) { return value; }
unsigned frame(void) { return frames; }
void clobber(void) { volatile unsigned char bytes[65536]; for(unsigned i=0;i<65536;i++) bytes[i]=i; }
''')
    flags = ['--target=wasm32-unknown-unknown', '-ffreestanding', '-O1',
             '-I', str(ROOT / 'engine/port')]
    objects = []
    for source in [fixture, ROOT / 'engine/port/kanto_scheduler.c', ROOT / 'engine/port/kanto_stack.s']:
        output = target / source.with_suffix('.o').name
        subprocess.run([compiler, *flags, '-c', str(source), '-o', str(output)], check=True)
        objects.append(str(output))
    allowed = target / 'asyncify-symbols.txt'
    allowed.write_text('KantoStartUnwind\nKantoStopUnwind\nKantoStartRewind\nKantoStopRewind\n')
    raw, wasm = target / 'raw.wasm', target / 'scheduler.wasm'
    subprocess.run(['wasm-ld', '--no-entry', '--export-all', '--stack-first', '-z', 'stack-size=1048576',
                    '--allow-undefined-file=' + str(allowed), *objects, '-o', str(raw)], check=True)
    subprocess.run(['wasm-opt', str(raw), '--fpcast-emu', '--asyncify',
                    '--pass-arg=asyncify-removelist@KantoRunGameStack', '--all-features', '-g',
                    '-o', str(wasm)], check=True)
    program = '''import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict';
const module=await WebAssembly.compile(readFileSync(process.argv[1]));
assert.deepEqual(WebAssembly.Module.imports(module),[]);
const make=async()=> (await WebAssembly.instantiate(module,{})).exports;
const a=await make();a.init();
let expected=0;
for(let i=1;i<=19;i++){assert.equal(a.step(i),0);assert.equal(a.frame(),i);a.clobber();
if(i%4===0) expected+=37+3*i;assert.equal(a.result(),expected);}
const checkpoint=new Uint8Array(a.memory.buffer).slice();
const b=await make();b.init();new Uint8Array(b.memory.buffer).set(checkpoint);
assert.equal(b.KantoSchedulerValidate(),0);
for(let i=20;i<=80;i++){assert.equal(a.step(i),0);assert.equal(b.step(i),0);a.clobber();b.clobber();
if(i%4===0) expected+=37+3*i;assert.equal(a.result(),expected);
assert.equal(a.result(),b.result());assert.equal(a.frame(),b.frame());}
assert.deepEqual(new Uint8Array(a.memory.buffer),new Uint8Array(b.memory.buffer));
console.log('Frame scheduler: nested waits, live C stack, unrelated ABI calls, and fresh-instance checkpoint replay passed');
'''
    subprocess.run(['node', '--input-type=module', '-e', program, str(wasm)], check=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
