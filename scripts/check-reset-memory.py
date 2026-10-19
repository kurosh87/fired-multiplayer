#!/usr/bin/env python3
"""Execute the real WASM passive-initializer/warm-memory-reset contract."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'


def main():
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve())]).returncode
    spec = importlib.util.spec_from_file_location('reset_memory', ROOT / 'engine/port/reset_memory.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    compiler = os.environ.get('KANTO_WASM_CC') or ('/opt/homebrew/opt/llvm/bin/clang'
                if Path('/opt/homebrew/opt/llvm/bin/clang').exists() else 'clang')
    target = ROOT / 'build/reset-memory-test'
    target.mkdir(parents=True, exist_ok=True)
    source = target / 'fixture.c'
    source.write_text('''typedef unsigned u32;
extern void KantoRestoreInitialMemory(void);
volatile u32 initialized=7;
volatile u32 uninitialized;
volatile unsigned char flash[16];
u32 add(u32 x){ return x+7; }
u32 (*volatile callback)(u32)=add;
u32 invoke(u32 x){return callback(x);}
u32 inspect(void){return initialized+uninitialized;}
u32 flashByte(void){return flash[0];}
void mutate(u32 n){initialized+=n;uninitialized=n;flash[0]=0x50+n;callback=0;}
u32 reset(u32 salt){
 volatile u32 retained=salt^0x12345678;
 volatile unsigned char preserved[16];
 for(u32 i=0;i<16;i++)preserved[i]=flash[i];
 KantoRestoreInitialMemory();
 for(u32 i=0;i<16;i++)flash[i]=preserved[i];
 if(retained!=(salt^0x12345678))__builtin_trap();
 return inspect();
}
''')
    objects = []
    for path in [source, ROOT / 'engine/port/kanto_reset.s']:
        output = target / path.with_suffix('.o').name
        subprocess.run([compiler, '--target=wasm32-unknown-unknown', '-ffreestanding', '-fno-builtin',
                        '-O1', '-c', str(path), '-o', str(output)], check=True)
        objects.append(str(output))
    raw, coroutine, wasm = target / 'raw.wasm', target / 'coroutine.wasm', target / 'reset.wasm'
    subprocess.run(['wasm-ld', '--no-entry', '--export-all', '--stack-first', '-z', 'stack-size=1048576',
                    '--initial-memory=4194304', '--max-memory=4194304', *objects, '-o', str(raw)], check=True)
    subprocess.run(['wasm-opt', str(raw), '--fpcast-emu', '--asyncify', '--all-features', '-g',
                    '-o', str(coroutine)], check=True)
    wasm.write_bytes(module.prepare(coroutine.read_bytes()))
    try:
        module.prepare(wasm.read_bytes())
    except module.ResetError:
        pass
    else:
        raise AssertionError('A module was prepared twice.')
    program = '''import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict';
const module=await WebAssembly.compile(readFileSync(process.argv[1]));
assert.deepEqual(WebAssembly.Module.imports(module),[]);
const make=async()=> (await WebAssembly.instantiate(module,{})).exports;
const a=await make();assert.equal(a.inspect(),7);assert.equal(a.invoke(10),17);
a.mutate(3);assert.equal(a.inspect(),13);assert.equal(a.flashByte(),0x53);
const checkpoint=new Uint8Array(a.memory.buffer).slice();
assert.equal(a.reset(0xabcdef),7);assert.equal(a.flashByte(),0x53);assert.equal(a.invoke(10),17);
a.mutate(9);assert.equal(a.reset(32),7);assert.equal(a.flashByte(),0x59);
const b=await make();new Uint8Array(b.memory.buffer).set(checkpoint);
assert.equal(b.inspect(),13);assert.equal(b.reset(123),7);assert.equal(b.flashByte(),0x53);
assert.equal(b.invoke(10),17);
console.log('WASM reset: initialized data, BSS, live ABI stack, preserved flash, function pointers and fresh checkpoint passed');
'''
    subprocess.run(['node', '--input-type=module', '-e', program, str(wasm)], check=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
