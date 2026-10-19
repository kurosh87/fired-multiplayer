import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('memory_layout', Path(__file__).resolve().parent.parent / 'engine/port/memory_layout.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

LAYOUT = '''
       -       8       dd TYPE
  100000  31711e   7677a5 .rodata
  8677b0  a7e8ce       48 .data
  867800  31711d   225ed0 .bss
  867800        0        4         file.o:(.bss.counter)
  867800        0        4                 counter
  105000   444444      200                 .L.crctable
'''


class MemoryLayoutTests(unittest.TestCase):
    def test_reads_linked_addresses_instead_of_file_offsets_or_input_sections(self):
        layout = module.read_layout(LAYOUT)
        self.assertEqual(layout['mutableBase'], 0x8677b0)
        self.assertEqual(layout['mutableEnd'], 0x867800 + 0x225ed0)
        self.assertEqual(layout['readonlyBytes'], 0x7677a5)

    def test_refuses_missing_duplicate_extra_overlapping_and_unaligned_sections(self):
        for changed in [LAYOUT.replace('.bss\n', '.other\n'),
                        LAYOUT + ' 900000 0 10 .data\n',
                        LAYOUT + ' 900000 0 10 .tdata\n',
                        LAYOUT.replace('8677b0', '867790'),
                        LAYOUT.replace('867800', '8677c0'),
                        LAYOUT.replace('8677b0', '8677b1'),
                        LAYOUT.replace('100000', '100010')]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                module.read_layout(changed)


if __name__ == '__main__':
    unittest.main()
