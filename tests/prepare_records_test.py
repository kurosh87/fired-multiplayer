import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare_records', Path(__file__).resolve().parent.parent / 'engine/port/prepare_records.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RecordTests(unittest.TestCase):
    def test_nested_definitions_references_and_literals(self):
        source = 'struct Outer { union { char x; short y; } a; struct Ref *p; }; const char *s="struct Fake {";'
        result = module.prepare(source)
        self.assertEqual(result.count('__attribute__((aligned(4)))'), 2)
        self.assertIn('struct Ref *p;', result)
        self.assertIn('"struct Fake {"', result)

    def test_packed_records_keep_their_original_layout(self):
        source = 'struct A { char x; } __attribute__((packed)); union __attribute__((__packed__)) B { char y; }; struct C { char z; };'
        self.assertEqual(module.prepare(source).count('__attribute__((aligned(4)))'), 1)

    def test_rejects_repeat_and_malformed_input(self):
        with self.assertRaises(ValueError): module.prepare(module.prepare('struct A { char x; };'))
        with self.assertRaises(ValueError): module.prepare('struct A {')


if __name__ == '__main__':
    unittest.main()
