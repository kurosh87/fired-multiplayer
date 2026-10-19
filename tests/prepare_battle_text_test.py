import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare_battle_text', Path(__file__).resolve().parent.parent / 'engine/port/prepare_battle_text.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BattleTextTests(unittest.TestCase):
    def test_definition_and_header_share_capacity(self):
        source = 'extern u8 gDisplayedStringBattle[300];\n           u8 gDisplayedStringBattle[300] = {0};\nu32 gBattleTypeFlags = 0;\n'
        result = module.prepare(source)
        self.assertEqual(result.count('gDisplayedStringBattle[1024]'), 2)
        self.assertIn('u32 gBattleTypeFlags = 0;', result)

    def test_rejects_repeated_or_drifted_storage(self):
        with self.assertRaises(ValueError):
            module.prepare(module.prepare('u8 gDisplayedStringBattle[300];\n'))
        with self.assertRaises(ValueError):
            module.prepare('extern u8 gDisplayedStringBattle[400];\n')

    def test_index_operations_and_inline_literals_are_unchanged(self):
        source = 'gDisplayedStringBattle[300] = EOS;\nconst char *text = "u8 gDisplayedStringBattle[300];";\n'
        self.assertEqual(module.prepare(source), source)


if __name__ == '__main__':
    unittest.main()
