#include "global.h"
#include "main.h"
#include "overworld.h"
#include "script.h"
#include "palette.h"
#include "pokemon.h"
#include "quest_log.h"
#include "fieldmap.h"
#include "save.h"
#include "new_game.h"
#include "constants/quest_log.h"
#include "constants/game_stat.h"
#include "kanto_exchange.h"
#include "kanto_lobby.h"

uint32_t kanto_lobby_save_abi_version(void) { return 1; }

/* Trusted server operation on a cloned verified checkpoint. Preserve the
 * post-save runtime as well as its cartridge in the lobby transaction. Never
 * run this on an unjournaled client state or concurrently with frame stepping. */
int32_t kanto_lobby_save(void)
{
    if (kanto_exchange_phase() != KANTO_EXCHANGE_CLOSED
        || gMain.callback1 != CB1_Overworld || !IsOverworldRunning()
        || gMain.callback2 == CB2_OverworldBasic || gPaletteFade.active
        || ArePlayerFieldControlsLocked() || ScriptContext_IsEnabled()
        || gQuestLogState == QL_STATE_PLAYBACK || gQuestLogState == QL_STATE_PLAYBACK_LAST
        || gPlayerAvatar.objectEventId >= OBJECT_EVENTS_COUNT
        || gPlayerAvatar.runningState != 0 || gPlayerAvatar.tileTransitionState != 0
        || gPlayerAvatar.transitionFlags || gPlayerAvatar.preventStep)
        return -1;
    struct ObjectEvent *player = &gObjectEvents[gPlayerAvatar.objectEventId];
    if (!player->active || player->singleMovementActive
        || (player->heldMovementActive && !player->heldMovementFinished)
        || !KantoGameStartMenuAllowsSave()) return -1;
    if (gPlayerPartyCount == 0 || gPlayerPartyCount > PARTY_SIZE) return -2;
    /* Replacing an existing adventure needs the original overwrite dialog.
     * A brand-new erased cartridge has no previous adventure to replace. */
    if (gDifferentSaveFile && gSaveFileStatus != SAVE_STATUS_EMPTY) return -4;
    /* Same map/recap preparation, statistic and serializer as the original
     * save dialog. No SaveBlock fields or Pokemon bytes are edited by JS. */
    SaveMapView();
    SaveQuestLogData();
    IncrementGameStat(GAME_STAT_SAVED_GAME);
    if (TrySavingData(gDifferentSaveFile ? SAVE_OVERWRITE_DIFFERENT_FILE : SAVE_NORMAL) != SAVE_STATUS_OK) return -3;
    gDifferentSaveFile = FALSE;
    return 0;
}
