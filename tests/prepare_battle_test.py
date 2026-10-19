import importlib.util
from pathlib import Path
import re
import unittest

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('prepare_battle',ROOT/'engine/port/prepare_battle.py')
battle=importlib.util.module_from_spec(spec);spec.loader.exec_module(battle)


@unittest.skipUnless((ROOT/'vendor/pokefirered-native/src/battle_main.c').exists(),'Pinned battle source not fetched')
class BattleBoundaries(unittest.TestCase):
    def test_original_mechanics_remain_unchanged(self):
        source=(ROOT/'vendor/pokefirered-native/src/battle_main.c').read_text()
        prepared=battle.prepare(source,'src/battle_main.c')
        for name in ['HandleTurnActionSelectionState','SetActionsAndBattlersTurnOrder','HandleEndTurn_FinishBattle']:
            matches=list(re.finditer(r'\b'+name+r'\([^;{}]*\)\s*\{',source));self.assertEqual(len(matches),1,name)
            start=source.index('{',matches[0].start())
            spec=importlib.util.spec_from_file_location('battle_test_braces',ROOT/'engine/port/prepare_main.py')
            parser=importlib.util.module_from_spec(spec);spec.loader.exec_module(parser)
            end=parser.closing_brace(source,start)
            self.assertIn(source[matches[0].start():end+1],prepared)
        self.assertNotIn('gReceivedRemoteLinkPlayers =',prepared)

    def test_all_pinned_transport_hooks_reject_drift_and_repeat(self):
        for name in ['link.c','battle_controllers.c','battle_main.c','menu_helpers.c','battle_controller_player.c']:
            relative=f'src/{name}';source=(ROOT/'vendor/pokefirered-native'/relative).read_text()
            prepared=battle.prepare(source,relative)
            self.assertIn('KantoBattleIsActive()',prepared)
            with self.assertRaises(ValueError):battle.prepare(prepared,relative)
            with self.assertRaises(ValueError):battle.prepare(source+source,relative)
        with self.assertRaises(ValueError):battle.prepare('void Unknown(void) {}','src/link.c')


if __name__=='__main__':unittest.main()
