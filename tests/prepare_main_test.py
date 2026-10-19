import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare_main', Path(__file__).resolve().parent.parent / 'engine/port/prepare_main.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SOURCE = '''
void AgbMain()
{
#if MODERN
    asm("{r0, r1}");
#endif
    Init();
    for (;;)
    {
        ReadKeys();
        Update();
        WaitForVBlank();
    }
}
void InitIntrHandlers(void)
{
    DmaCopy32(3, intr_main, IntrMain_Buffer, sizeof(IntrMain_Buffer));
    INTR_VECTOR = IntrMain_Buffer;
}
'''

class PreparationTests(unittest.TestCase):
    def test_split_preserves_game_logic_and_exposes_frame_boundary(self):
        prepared = module.prepare(SOURCE)
        self.assertNotIn('for (;;)', prepared)
        self.assertIn('void KantoGameFrame(void)', prepared)
        self.assertIn('ReadKeys();', prepared)
        self.assertIn('Update();', prepared)
        self.assertIn('VBlankIntr();', prepared)
        self.assertIn('KantoPlatformFrameBegin();', prepared)
        self.assertIn('#if MODERN && !defined(KANTO_WASM)', prepared)
        self.assertEqual(prepared.count('Init();'), 1)

    def test_refuses_unexpected_upstream_shapes_and_repeat_application(self):
        with self.assertRaises(ValueError): module.prepare(SOURCE.replace('WaitForVBlank();','ChangedLoop();'))
        with self.assertRaises(ValueError): module.prepare(module.prepare(SOURCE))

    def test_brace_parser_ignores_comments_and_literals(self):
        text = '{ /* } */ "}"; \'{\'; // }\n { x(); } }'
        self.assertEqual(module.closing_brace(text,0),len(text)-1)

if __name__ == '__main__': unittest.main()
