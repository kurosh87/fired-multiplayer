import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hardware = load('prepare_hardware', 'engine/port/prepare_hardware.py')
pipeline = load('prepare_engine', 'scripts/prepare-engine.py')


def header(definitions):
    return '\n'.join(f'#define {name} {old}' for name, (old, _) in definitions.items()) + '\n'


class HardwarePreparationTests(unittest.TestCase):
    def test_maps_special_memory_without_changing_derived_addresses(self):
        original = header(hardware.DEFINES) + '#define BG_PLTT PLTT\n#define OBJ_PLTT (PLTT + 0x200)\n'
        output = hardware.prepare(original, 'defines')
        self.assertIn('#include "kanto_hardware.h"', output)
        self.assertIn('#ifndef KANTO_WASM', output)
        for name, (_, mapped) in hardware.DEFINES.items():
            self.assertIn(f'#define {name} {mapped}\n', output)
        self.assertIn('#define BG_PLTT PLTT\n#define OBJ_PLTT (PLTT + 0x200)\n', output)

    def test_keeps_register_offset_and_volatile_access_definitions(self):
        original = ('#define REG_BASE 0x4000000 // GBA registers\n'
                    '#define REG_OFFSET_KEYINPUT 0x130\n'
                    '#define REG_KEYINPUT (*(vu16 *)(REG_BASE + REG_OFFSET_KEYINPUT))\n')
        output = hardware.prepare(original, 'registers')
        self.assertIn('#define REG_BASE ((uintptr_t)gKantoHardware.registers)', output)
        self.assertIn('#define REG_KEYINPUT (*(vu16 *)(REG_BASE + REG_OFFSET_KEYINPUT))', output)

    def test_rejects_missing_duplicate_changed_or_already_prepared_macros(self):
        original = header(hardware.DEFINES)
        mutations = [original.replace('#define VRAM 0x6000000\n', ''),
                     original + '#define VRAM 0x6000000\n',
                     original.replace('0x6000000', '0x6000004'),
                     hardware.prepare(original, 'defines')]
        for text in mutations:
            with self.subTest(text=text), self.assertRaises(ValueError):
                hardware.prepare(text, 'defines')

    def test_refuses_partial_or_wrong_source_before_generating_output(self):
        # A matching marker alone is insufficient: modified source must fail.
        with tempfile.TemporaryDirectory(prefix='kanto-source-check-') as directory:
            source = Path(directory)
            (source / 'src').mkdir()
            (source / 'src/main.c').write_text('modified source')
            with self.assertRaisesRegex(ValueError, 'reviewed pinned source'):
                pipeline.prepare_files(source, {'portInputs': {'src/main.c': '0' * 64}})


if __name__ == '__main__':
    unittest.main()
