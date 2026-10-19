"""Reviewed WASM adaptations for the pinned portable FireRed source.

Only hardware/ABI boundaries change. The original vendor files stay untouched.
Physical cartridge multiboot remains unsupported and fails explicitly.
"""
import importlib.util
from pathlib import Path
import re


def closing_brace(source, start):
    spec = importlib.util.spec_from_file_location('kanto_main_preparation', Path(__file__).with_name('prepare_main.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.closing_brace(source, start)


def prepare(source, relative):
    if 'KANTO_WASM_PREPARED' in source:
        raise ValueError('Source has already been prepared.')
    if relative == 'src/main.c':
        function = re.search(r'void\s+AgbMain\s*\(\s*\)\s*\{', source)
        if not function:
            raise ValueError('Expected the portable AgbMain definition.')
        start = source.index('{', function.start())
        end = closing_brace(source, start)
        loop = re.search(r'for\s*\(\s*;\s*;\s*\)\s*\{', source[start:end])
        if not loop:
            raise ValueError('Expected the portable game loop.')
        loop_start = start + loop.start()
        loop_body = source.index('{', loop_start)
        loop_end = closing_brace(source, loop_body)
        if source[loop_end + 1:end].strip():
            raise ValueError('Unexpected code after the portable game loop.')
        initialization = source[start + 1:loop_start].replace('    u32 portableFrame = 0;', '')
        frame = source[loop_body + 1:loop_end]
        frame, logs = re.subn(r'#ifdef PORTABLE\s*if \(\+\+portableFrame % 300 == 0\)\s*SDL_Log\([^;]+;\s*#endif', '', frame)
        if logs != 1 or frame.count('WaitForVBlank();') != 1:
            raise ValueError('The portable frame boundary changed upstream.')
        frame = frame.replace('WaitForVBlank();', 'KantoYieldFrame();')
        source = source[:start + 1] + initialization + '\n}\n\nvoid KantoGameFrame(void)\n{\n    KantoPlatformFrameBegin();\n' + frame + '\n}' + source[end + 1:]
        trampoline = re.compile(r'DmaCopy32\(3, intr_main, IntrMain_Buffer, sizeof\(IntrMain_Buffer\)\);\s*INTR_VECTOR = IntrMain_Buffer;')
        source, count = trampoline.subn('INTR_VECTOR = NULL; /* Compiled IRQ callbacks replace the ARM trampoline. */', source)
        if count != 1:
            raise ValueError('The portable interrupt boundary changed upstream.')
        source = '#include "kanto_platform.h"\n#include "kanto_scheduler.h"\n' + source
        # No physical RFU device was initialized by the portable boot path.
        # Its shutdown cannot be invoked before the browser's RAM reset.
        for call in ['            rfu_REQ_stopMode();', '            rfu_waitREQComplete();']:
            if source.count(call) != 1:
                raise ValueError('The soft-reset RFU shutdown boundary changed upstream.')
            source = source.replace(call, '            /* No physical RFU peer in this port. */')
        timestamp = 'const char BuildDateTime[] = __DATE__ " " __TIME__;'
        if source.count(timestamp) != 1:
            raise ValueError('The original build metadata boundary changed upstream.')
        source = source.replace(timestamp, 'const char BuildDateTime[] = "2004 07 20 09:30";')
        # Portable C has no instruction-cycle hardware clock. Preserve the
        # original PRNG/trainer-ID code while replacing its entropy boundary
        # with a trusted-seed, frame-driven counter in canonical memory.
        for old, new in [('    REG_TM1CNT_H = 0x80;', '    KantoPlatformEntropyStart();'),
                         ('    u16 val = REG_TM1CNT_L;', '    u16 val = KantoPlatformEntropyRead();')]:
            if source.count(old) != 1:
                raise ValueError('The title entropy boundary changed upstream.')
            source = source.replace(old, new)
    elif relative == 'src/librfu_intr.c':
        replacements = {
            'asm("bx r2");': 'callbackM(reqCommandId, error);',
            'asm("bx r1");': 'callbackS(reqCommandId);',
            'asm("bx r0");': 'callbackId();',
        }
        for old, new in replacements.items():
            if source.count(old) != 1:
                raise ValueError('RFU tail-call wrappers changed upstream.')
            source = source.replace(old, new)
        source, count = re.subn(r'\nNAKED\s*\n', '\n', source)
        if count != 3:
            raise ValueError('RFU wrapper attributes changed upstream.')
    elif relative == 'src/script.c':
        if source.count('asm("svc 2");') != 1:
            raise ValueError('The fatal script HALT boundary changed upstream.')
        source = source.replace('asm("svc 2");', '__builtin_trap();')
    elif relative == 'src/multiboot.c':
        match = re.search(r'static NOINLINE void MultiBootWaitCycles\(u32 cycles\)\s*\{', source)
        if not match:
            raise ValueError('The physical multiboot wait boundary changed upstream.')
        start = source.index('{', match.start())
        end = closing_brace(source, start)
        if 'MultiBootWaitCyclesLoop' not in source[start:end]:
            raise ValueError('Expected the original ARM timing loop.')
        source = source[:start] + '{\n    (void)cycles;\n    __builtin_trap(); /* Physical cartridge multiboot is unsupported. */\n}' + source[end + 1:]
    elif relative == 'src/pokemon.c':
        # ARM accepts the library's two/three-argument aliases. WASM gives
        # functions exact types, so preserve that API through explicit calls.
        for name, kind in [('GetMonData', 'Pokemon'), ('GetBoxMonData', 'BoxPokemon')]:
            old = f'u32 {name}2(struct {kind} *' + ('mon' if kind == 'Pokemon' else 'boxMon')
            parameter = 'mon' if kind == 'Pokemon' else 'boxMon'
            old += f', s32 field) __attribute__((alias("{name}3")));'
            new = f'u32 {name}2(struct {kind} *{parameter}, s32 field) {{ return {name}3({parameter}, field, NULL); }}'
            if source.count(old) != 1:
                raise ValueError('The overloaded Pokemon data ABI changed upstream.')
            source = source.replace(old, new)
    elif relative in ('src/trade.c', 'src/trade_scene.c'):
        spec = importlib.util.spec_from_file_location('prepare_trade', Path(__file__).with_name('prepare_trade.py'))
        trade = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(trade)
        source = trade.prepare(source, relative)
    elif relative == 'src/start_menu.c':
        # Restore the original game's EXIT behavior: close the menu. The
        # native reference fork additionally quits its application here.
        if source.count('    Platform_ExitApplication();') != 1:
            raise ValueError('The native menu exit boundary changed upstream.')
        source = source.replace('    Platform_ExitApplication();', '')
        source = '#include "kanto_lobby.h"\n' + source + '\n' + Path(__file__).with_name('lobby_helpers.inc.c').read_text()
    else:
        return source
    return '#define KANTO_WASM_PREPARED 1\n' + source
