#!/usr/bin/env python3
"""Execute a real ARM-data -> WASM relocation contract, never a game substitute."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'


def main():
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve())]).returncode
    compiler = os.environ.get('KANTO_WASM_CC') or ('/opt/homebrew/opt/llvm/bin/clang'
                if Path('/opt/homebrew/opt/llvm/bin/clang').exists() else 'clang')
    for name in ['arm-none-eabi-as', compiler, 'wasm-ld', 'node']:
        if not shutil.which(name):
            raise SystemExit(f'Required data conversion tool is missing: {name}')
    spec = importlib.util.spec_from_file_location('elf_data', ROOT / 'engine/port/elf_data.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    target = ROOT / 'build/data-conversion-test'
    target.mkdir(parents=True, exist_ok=True)
    assembly = target / 'data.arm.s'
    assembly.write_text('''.section .rodata
.balign 4
.global ExampleData
ExampleData:
.word 0x12345678
.word ExampleFunction
.word Tail+2
.word Tail-1
.word VoidCallback
.word ShortCallback
.global Tail
Tail:
.byte 1,2,3,4
.section .data
.balign 8
.global MutableData
MutableData:
.word 0x87654321
.word ExampleData
.section .bss
.balign 16
.global MutableZero
MutableZero:
.space 16
''')
    source = target / 'functions.c'
    source.write_text('''typedef unsigned int u32;
extern const u32 ExampleData[];
extern u32 MutableData[], MutableZero[];
u32 mutableAddress(void) { return (u32)MutableData; }
u32 zeroAddress(void) { return (u32)MutableZero; }
u32 dataValue(void) { return MutableData[0]; }
u32 zeroValue(void) { return MutableZero[0]; }
u32 dataPointer(void) { return *((u32 *)MutableData[1]); }
void mutate(void) { MutableData[0]+=1;MutableZero[0]=37; }
u32 ExampleFunction(u32 x) { return x+7; }
u32 callbackResult;
void VoidCallback(void) { callbackResult=23; }
u32 ShortCallback(u32 x) { return x+9; }
u32 inspect(void) { return ExampleData[0]; }
u32 invoke(u32 x) { return ((u32 (*)(u32))ExampleData[1])(x); }
u32 tail(void) { return *(const unsigned char *)ExampleData[2]; }
u32 negative(void) { return *((const unsigned char *)ExampleData[3]+1); }
u32 castVoid(void) { return ((u32 (*)(u32))ExampleData[4])(100); }
u32 castExtra(u32 x) { return ((u32 (*)(u32,u32))ExampleData[5])(x,200); }
u32 result(void) { return callbackResult; }
''')
    arm_object = target / 'data.arm.o'
    c_assembly = target / 'functions.wasm.s'
    c_object = target / 'functions.wasm.o'
    wasm_assembly = target / 'data.wasm.s'
    wasm_object = target / 'data.wasm.o'
    wasm = target / 'relocations.wasm'
    subprocess.run(['arm-none-eabi-as', '-o', str(arm_object), str(assembly)], check=True)
    subprocess.run([compiler, '--target=wasm32-unknown-unknown', '-S', '-O1', '-ffreestanding',
                    str(source), '-o', str(c_assembly)], check=True)
    wasm_assembly.write_text(module.convert(arm_object.read_bytes(), arm_object,
                                           module.signatures_from_assembly([c_assembly])))
    assert '.section .data.' in wasm_assembly.read_text()
    assert '.section .bss.' in wasm_assembly.read_text()
    for source_path, output in [(c_assembly, c_object), (wasm_assembly, wasm_object)]:
        subprocess.run([compiler, '--target=wasm32-unknown-unknown', '-c', str(source_path), '-o', str(output)], check=True)
    subprocess.run(['wasm-ld', '--no-entry', '--stack-first', '-z', 'stack-size=65536',
                    '--global-base=65536', '--export=inspect', '--export=invoke', '--export=tail',
                    '--export=negative', '--export=castVoid', '--export=castExtra', '--export=result',
                    '--export=mutableAddress', '--export=zeroAddress', '--export=dataValue',
                    '--export=zeroValue', '--export=dataPointer', '--export=mutate',
                    '-Map=' + str(target / 'relocations.map'),
                    str(c_object), str(wasm_object), '-o', str(wasm)], check=True)
    layout_spec = importlib.util.spec_from_file_location('memory_layout', ROOT / 'engine/port/memory_layout.py')
    layout_module = importlib.util.module_from_spec(layout_spec)
    layout_spec.loader.exec_module(layout_module)
    layout = layout_module.read_layout((target / 'relocations.map').read_text(), static_base=65536)
    program = '''import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const module = await WebAssembly.compile(readFileSync(process.argv[1]));
assert.deepEqual(WebAssembly.Module.imports(module), []);
const {exports:core}=await WebAssembly.instantiate(module,{});
assert.equal(core.inspect()>>>0,0x12345678);
assert.equal(core.invoke(10),17);
assert.equal(core.tail(),3);
assert.equal(core.negative(),1);
assert(core.mutableAddress()>=Number(process.argv[2]));
assert(core.zeroAddress()>=Number(process.argv[2]));
assert(core.mutableAddress()<Number(process.argv[3]));
assert(core.zeroAddress()<Number(process.argv[3]));
assert.equal(core.dataValue()>>>0,0x87654321);assert.equal(core.zeroValue(),0);
assert.equal(core.dataPointer()>>>0,0x12345678);
core.mutate();assert.equal(core.dataValue()>>>0,0x87654322);assert.equal(core.zeroValue(),37);
console.log('ARM data -> WASM: bytes, pointers, signed addends, writable data and BSS placement passed');
'''
    subprocess.run(['node', '--input-type=module', '-e', program, str(wasm),
                    str(layout['mutableBase']), str(layout['mutableEnd'])], check=True)
    normalized = target / 'callbacks.wasm'
    subprocess.run(['wasm-opt', str(wasm), '--fpcast-emu', '--all-features', '-o', str(normalized)], check=True)
    callback_program = '''import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict';
const {instance:{exports:c}}=await WebAssembly.instantiate(readFileSync(process.argv[1]),{});
assert.equal(c.invoke(10),17);assert.equal(c.castVoid(),0);assert.equal(c.result(),23);
assert.equal(c.castExtra(10),19);
console.log('ARM callback casts -> WASM: discarded results and extra arguments passed');
'''
    subprocess.run(['node', '--input-type=module', '-e', callback_program, str(normalized)], check=True)
    # Unexpected executable objects must never be embedded as game data.
    executable_source = target / 'executable.arm.s'
    executable_object = target / 'executable.arm.o'
    executable_source.write_text('.text\n.global Executable\nExecutable:\nmov r0,r0\n')
    subprocess.run(['arm-none-eabi-as', '-o', str(executable_object), str(executable_source)], check=True)
    try:
        module.convert(executable_object.read_bytes(), executable_object)
    except module.ElfError as error:
        if 'machine code' not in str(error):
            raise
    else:
        raise AssertionError('Executable ARM section was accepted.')
    print('ARM instruction rejection passed', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
