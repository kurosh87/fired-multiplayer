"""Reviewed original link boundaries for an isolated two-player C battle.

No battle AI, move rules, damage or controller handlers are replaced. The
physical cable endpoints become bounded server-owned memory block endpoints.
"""
import importlib.util
from pathlib import Path
import re


def body(source, name, transform):
    matches=list(re.finditer(r'\b(?:static\s+)?(?:void|bool8|u8|u16|u32|int|s32)\s+'
                            +re.escape(name)+r'\([^;{}()]*\)\s*\{', source))
    if len(matches)!=1: raise ValueError(f'Original battle boundary changed: {name}')
    start=source.index('{',matches[0].start())
    spec=importlib.util.spec_from_file_location('battle_braces',Path(__file__).with_name('prepare_main.py'))
    parser=importlib.util.module_from_spec(spec);spec.loader.exec_module(parser)
    end=parser.closing_brace(source,start)
    return source[:start+1]+transform(source[start+1:end])+source[end:]


def once(source, old, new):
    if source.count(old)!=1: raise ValueError('Original battle transport source drifted.')
    return source.replace(old,new)


def prepare(source, relative):
    if '#include "kanto_battle.h"' in source: raise ValueError('Battle source was already prepared.')
    if relative=='src/link.c':
        hooks={
            'GetMultiplayerId':'if (KantoBattleIsActive()) return KantoBattlePlayer();',
            'GetLinkPlayerCount':'if (KantoBattleIsActive()) return 2;',
            'GetLinkPlayerCount_2':'if (KantoBattleIsActive()) return 2;',
            'SendBlock':'if (KantoBattleIsActive()) return KantoBattleSend(src, size);',
            'IsLinkTaskFinished':'if (KantoBattleIsActive()) return KantoBattleSendFinished();',
            'GetBlockReceivedStatus':'if (KantoBattleIsActive()) return KantoBattleReceived();',
            'ResetBlockReceivedFlags':'if (KantoBattleIsActive()) { KantoBattleResetReceived(3); return; }',
            'ResetBlockReceivedFlag':'if (KantoBattleIsActive()) { if (who < 2) KantoBattleResetReceived(1u << who); return; }',
            'SetCloseLinkCallback':'if (KantoBattleIsActive()) return;',
        }
        for name,hook in hooks.items(): source=body(source,name,lambda original,hook=hook:'\n    '+hook+'\n'+original)
    elif relative=='src/battle_controllers.c':
        source=body(source,'HandleLinkBattleSetup',lambda original: '''
    if (KantoBattleIsActive())
    {
        CreateTasksForSendRecvLinkBuffers();
        gTasks[sLinkSendTaskId].data[11] = 3;
        return;
    }
'''+original)
        source=body(source,'TryReceiveLinkBattleData',lambda original:once(original,
            'gReceivedRemoteLinkPlayers != 0 &&', '(gReceivedRemoteLinkPlayers != 0 || KantoBattleIsActive()) &&'))
    elif relative=='src/battle_main.c':
        source=body(source,'CB2_HandleStartBattle',lambda original:once(original,
            'if (gReceivedRemoteLinkPlayers)', 'if (gReceivedRemoteLinkPlayers || KantoBattleIsActive())'))
        source=body(source,'CB2_InitEndLinkBattle',lambda original:'\n    if (KantoBattleIsActive()) { KantoBattleFinish(); return; }\n'+original)
        source+='''
/* Read-only server deadline metadata; original selection code is unchanged. */
uint32_t KantoGameBattleTurnRequest(void)
{
    if (!(gBattleTypeFlags & BATTLE_TYPE_IS_MASTER) || gBattleMainFunc != HandleTurnActionSelectionState) return 0;
    uint32_t mask = 0;
    for (uint32_t i = 0; i < 2 && i < gBattlersCount; i++)
        if (gBattleCommunication[i] != STATE_WAIT_ACTION_CONFIRMED_STANDBY
            && gBattleCommunication[i] != STATE_WAIT_ACTION_CONFIRMED) mask |= 1u << i;
    return 0x100u | mask;
}
'''
    elif relative=='src/battle_controller_player.c':
        for name in ['HandleInputChooseAction','HandleInputChooseMove','OpenPartyMenuToChooseMon','WaitForMonSelection']:
            source=body(source,name,lambda original:original)
        source+='''
/* Keep summary/menu visits inside the same replacement decision deadline. */
uint32_t KantoGameBattlePlayerRequest(uint32_t player)
{
    if (!KantoBattleIsActive() || player > 1 || player >= gBattlersCount) return 0;
    if (gBattlerControllerFuncs[player] == HandleInputChooseAction) return 1;
    if (gBattlerControllerFuncs[player] == HandleInputChooseMove) return 2;
    if (gBattlerControllerFuncs[player] == OpenPartyMenuToChooseMon
        || gBattlerControllerFuncs[player] == WaitForMonSelection) return 3;
    return 0;
}
'''
    elif relative=='src/menu_helpers.c':
        # Original party/summary menus preserve link tasks only when this
        # predicate is true. Our bounded transport really is active; reporting
        # no link here destroys its send/receive tasks during a forced switch.
        source=body(source,'MenuHelpers_IsLinkActive',lambda original:'\n    if (KantoBattleIsActive()) return TRUE;\n'+original)
    else: raise ValueError('Unknown battle transport source.')
    return '#include "kanto_battle.h"\n'+source
