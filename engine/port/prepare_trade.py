"""Replace physical link transport boundaries, retaining original trade rules."""
import importlib.util
from pathlib import Path
import re


def function_body(source, name, transform):
    matches = list(re.finditer(r'(?:static\s+)?void\s+' + re.escape(name) + r'\(void\)\s*\{', source))
    if len(matches) != 1:
        raise ValueError(f'The original trade callback changed: {name}')
    start = source.index('{', matches[0].start())
    spec = importlib.util.spec_from_file_location('trade_braces', Path(__file__).with_name('prepare_main.py'))
    parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(parser)
    end = parser.closing_brace(source, start)
    return source[:start + 1] + transform(source[start + 1:end]) + source[end:]


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('The original trade transport boundary changed.')
    return text.replace(old, new)


def prepare(source, relative):
    if '#include "kanto_exchange.h"' in source:
        raise ValueError('Trade source has already been prepared.')
    if relative == 'src/trade.c':
        return '#include "kanto_exchange.h"\n' + source + '\n' + Path(__file__).with_name('trade_helpers.inc.c').read_text()
    if relative != 'src/trade_scene.c':
        raise ValueError('Unknown trade source.')

    def bootstrap(body):
        if body.count('if (!gReceivedRemoteLinkPlayers)') != 2:
            raise ValueError('The original cable bootstrap changed.')
        body = body.replace('if (!gReceivedRemoteLinkPlayers)',
                            'if (!gReceivedRemoteLinkPlayers && !KantoExchangeIsTrade())', 1)
        return replace_once(body, '    case 1:\n        if (!gReceivedRemoteLinkPlayers)',
                            '''    case 1:
        if (KantoExchangeIsTrade())
        {
            /* The server has supplied both canonical parties and metadata.
             * Physical cable negotiation is not part of a browser session. */
            sTradeAnim->isCableTrade = TRUE;
            gMain.state = 5;
            break;
        }
        if (!gReceivedRemoteLinkPlayers)''')

    def exchanged(body):
        body = replace_once(body, '        SetMainCallback2(CB2_WaitTradeComplete);', '''        if (KantoExchangeIsTrade())
            SetMainCallback2(CB2_TryLinkTradeEvolution);
        else
            SetMainCallback2(CB2_WaitTradeComplete);''')
        return replace_once(body, '    HandleLinkDataSend();\n    HandleLinkDataReceive();', '''    if (!KantoExchangeIsTrade())
    {
        HandleLinkDataSend();
        HandleLinkDataReceive();
    }''')

    def save(body):
        return '''
    if (KantoExchangeIsTrade())
    {
        /* All original swap/evolution/move-learning callbacks have finished.
         * Each side now produces a staged cartridge; the host must commit
         * BOTH cartridges and the receipt atomically before success. */
        SetQuestLogEvent(QL_EVENT_LINK_TRADED, (void *)&sTradeAnim->questLogData);
        IncrementGameStat(GAME_STAT_POKEMON_TRADES);
        KantoExchangeFinishTrade();
        return;
    }
''' + body

    source = function_body(source, 'CB2_LinkTrade', bootstrap)
    source = function_body(source, 'CB2_UpdateLinkTrade', exchanged)
    source = function_body(source, 'CB2_SaveAndEndTrade', save)
    return '#include "kanto_exchange.h"\n' + source
