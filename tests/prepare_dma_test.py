import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare_dma', Path(__file__).resolve().parent.parent / 'engine/port/prepare_dma.py')
dma = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dma)


def original():
    return '\n'.join('#define ' + signature + ' \\\n' + ' \\\n'.join(body.splitlines()) + '\n'
                     for signature, body in dma.ORIGINAL.values())


class DmaPreparationTests(unittest.TestCase):
    def test_routes_dma_helpers_and_preserves_other_macros(self):
        source = original() + '#define ExampleCopy(src, dst) DmaSet(3, src, dst, 0x80000001)\n'
        prepared = dma.prepare(source)
        self.assertIn('KantoDmaSet((dmaNum)', prepared)
        self.assertIn('KantoDmaStop((dmaNum))', prepared)
        self.assertNotIn('dmaRegs', prepared)
        self.assertIn('#define ExampleCopy(src, dst) DmaSet(3, src, dst, 0x80000001)', prepared)

    def test_rejects_unknown_changed_and_repeated_macros(self):
        for source in [original().replace('dmaRegs[2];', 'Changed();'),
                       original().replace('DmaStop(dmaNum)', 'Other(dmaNum)'),
                       original() + original(), dma.prepare(original())]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                dma.prepare(source)


if __name__ == '__main__': unittest.main()
