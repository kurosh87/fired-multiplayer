import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('prepare_trade', ROOT / 'engine/port/prepare_trade.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SCENE = '''
void CB2_LinkTrade(void) {
    case 0:
        if (!gReceivedRemoteLinkPlayers) CloseLink();
    case 1:
        if (!gReceivedRemoteLinkPlayers) OriginalNegotiation();
}
static void CB2_UpdateLinkTrade(void) {
    TradeMons();
        SetMainCallback2(CB2_WaitTradeComplete);
    HandleLinkDataSend();
    HandleLinkDataReceive();
}
static void CB2_SaveAndEndTrade(void) { OriginalSave(); }
static void TradeMons(void) { OriginalSwapAndMail(); }
'''


class TradeTests(unittest.TestCase):
    def test_transport_boundaries_and_original_scene_preserved(self):
        prepared = module.prepare(SCENE, 'src/trade_scene.c')
        self.assertIn('OriginalNegotiation();', prepared)
        self.assertIn('static void TradeMons(void) { OriginalSwapAndMail(); }', prepared)
        self.assertIn('SetMainCallback2(CB2_TryLinkTradeEvolution);', prepared)
        self.assertIn('KantoExchangeFinishTrade();', prepared)
        self.assertIn('OriginalSave();', prepared)
        self.assertNotIn('gReceivedRemoteLinkPlayers =', prepared)

    def test_rejects_source_drift_and_repeat(self):
        with self.assertRaises(ValueError): module.prepare(SCENE.replace('HandleLinkDataReceive();', 'Changed();'), 'src/trade_scene.c')
        with self.assertRaises(ValueError): module.prepare(module.prepare(SCENE, 'src/trade_scene.c'), 'src/trade_scene.c')
        with self.assertRaises(ValueError): module.prepare(SCENE + SCENE, 'src/trade_scene.c')

    @unittest.skipUnless((ROOT / 'vendor/pokefirered-native/src/trade_scene.c').exists(), 'Pinned source not fetched')
    def test_pinned_original_swap_evolution_and_animation_bodies_unchanged(self):
        source = (ROOT / 'vendor/pokefirered-native/src/trade_scene.c').read_text()
        prepared = module.prepare(source, 'src/trade_scene.c')
        # Extract full definitions with the same checked brace parser. These
        # mechanics must be byte-identical, beyond the three transport hooks.
        import re
        for name in ['TradeMons', 'CB2_TryLinkTradeEvolution', 'DoTradeAnim']:
            match = re.search(r'\b' + name + r'\([^;{}]*\)\s*\{', source)
            self.assertIsNotNone(match, name)
            start = source.index('{', match.start())
            parser_spec = importlib.util.spec_from_file_location('braces', ROOT / 'engine/port/prepare_main.py')
            parser = importlib.util.module_from_spec(parser_spec)
            parser_spec.loader.exec_module(parser)
            end = parser.closing_brace(source, start)
            self.assertIn(source[match.start():end + 1], prepared)


if __name__ == '__main__':
    unittest.main()
