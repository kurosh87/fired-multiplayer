#include "global.h"
#include "main.h"
#include "battle.h"
#include "battle_main.h"
#include "battle_controllers.h"
#include "link.h"
#include "pokemon.h"
#include "scanline_effect.h"
#include "overworld.h"
#include "constants/trainers.h"
#include "characters.h"
#include "party_menu.h"
#include "script_pokemon_util.h"
#include "constants/songs.h"
#include "constants/maps.h"
#include "kanto_exchange.h"
#include "kanto_battle.h"
#include "../include/kanto_abi.h"

#define HELLO_MAGIC 0x4b425431u
struct BattleHello { uint32_t magic, abi; struct LinkPlayer player; };
struct BattleBlock { uint32_t player, size, serial; uint8_t data[BLOCK_BUFFER_SIZE]; };
static struct {
    uint32_t phase, player, received, next_serial;
    uint32_t received_serial[2];
    struct BattleHello hello, peer;
    struct BattleBlock outgoing, incoming;
} sBattle;
_Static_assert(sizeof(struct LinkPlayer) == 28, "Original link identity ABI");
_Static_assert(sizeof(struct Pokemon) == 100, "Original party ABI");
_Static_assert(sizeof(struct BattleBlock) == 268, "Review bounded battle transport ABI");

static void BattleIdle(void) {}
uint32_t kanto_battle_abi_version(void) { return 1; }
uint32_t kanto_battle_phase(void) { return sBattle.phase; }
uint32_t kanto_battle_decision(void)
{
    if (sBattle.phase != 2) return 0;
    return KantoGameBattleTurnRequest() | (KantoGameBattlePlayerRequest(sBattle.player) << 16);
}
uint32_t KantoBattleIsActive(void) { return sBattle.phase == 2 || sBattle.phase == 3; }
uint32_t KantoBattlePlayer(void) { return sBattle.player; }

int32_t kanto_battle_open(uint32_t player)
{
    if (sBattle.phase || player > 1 || kanto_frame() != 0) return -1;
    /* Reuse the original cartridge/party loader and encrypted-record checks.
     * Opening a battle cannot create Pokemon or change an adventure save. */
    if (kanto_exchange_open() != 0) return -2;
    /* CableClub_EventScript_EnterColosseum calls the original healer before
     * preserving the player's field party. Only this isolated RAM copy heals. */
    HealPlayerParty();
    bool32 usable = FALSE;
    for (uint32_t i = 0; i < gPlayerPartyCount; i++)
        if (!GetMonData(&gPlayerParty[i], MON_DATA_IS_EGG)
            && GetMonData(&gPlayerParty[i], MON_DATA_HP)) usable = TRUE;
    if (!usable) return -3;
    sBattle.player = player;
    sBattle.phase = 1;
    sBattle.next_serial = 1;
    gLinkType = LINKTYPE_BATTLE;
    LocalLinkPlayerToBlock();
    sBattle.hello.magic = HELLO_MAGIC;
    sBattle.hello.abi = 1;
    sBattle.hello.player = gLocalLinkPlayer;
    sBattle.hello.player.id = player;
    return 0;
}
uint32_t kanto_battle_hello_ptr(void) { return sBattle.phase == 1 ? (uint32_t)(uintptr_t)&sBattle.hello : 0; }
uint32_t kanto_battle_peer_ptr(void) { return sBattle.phase == 1 ? (uint32_t)(uintptr_t)&sBattle.peer : 0; }
uint32_t kanto_battle_hello_size(void) { return sizeof(struct BattleHello); }
int32_t kanto_battle_start(void)
{
    struct LinkPlayer *peer = &sBattle.peer.player;
    if (sBattle.phase != 1 || sBattle.peer.magic != HELLO_MAGIC || sBattle.peer.abi != 1
        || peer->id != (sBattle.player ^ 1) || peer->linkType != LINKTYPE_BATTLE
        || ((peer->version & 255) != VERSION_FIRE_RED && (peer->version & 255) != VERSION_LEAF_GREEN)) return -1;
    bool32 terminated = FALSE;
    for (uint32_t i = 0; i < sizeof(peer->name); i++) if (peer->name[i] == EOS) terminated = TRUE;
    if (!terminated || gWirelessCommType || gReceivedRemoteLinkPlayers) return -2;
    gLinkPlayers[sBattle.player] = sBattle.hello.player;
    gLinkPlayers[sBattle.player ^ 1] = *peer;
    ConvertLinkPlayerName(&gLinkPlayers[0]); ConvertLinkPlayerName(&gLinkPlayers[1]);
    gBattleTypeFlags = BATTLE_TYPE_TRAINER | BATTLE_TYPE_LINK;
    gTrainerBattleOpponent_A = TRAINER_LINK_OPPONENT;
    /* Link battles take place in the original Colosseum, independently of
     * where either adventure paused. Terrain affects original move rules. */
    gMapHeader = *Overworld_GetMapHeaderByGroupAndId(MAP(MAP_BATTLE_COLOSSEUM_2P));
    gMain.callback1 = NULL;
    gMain.savedCallback = BattleIdle;
    PlayMapChosenOrBattleBGM(gLinkPlayers[0].trainerId & 1 ? MUS_RS_VS_GYM_LEADER : MUS_RS_VS_TRAINER);
    sBattle.phase = 2;
    SetMainCallback2(CB2_InitBattle);
    return 0;
}

uint32_t KantoBattleSend(const void *source, uint32_t size)
{
    if (!KantoBattleIsActive() || !source || !size || size > BLOCK_BUFFER_SIZE || sBattle.outgoing.size) return FALSE;
    sBattle.outgoing.player = sBattle.player;
    sBattle.outgoing.size = size;
    sBattle.outgoing.serial = sBattle.next_serial++;
    memset(sBattle.outgoing.data, 0, sizeof(sBattle.outgoing.data));
    memcpy(sBattle.outgoing.data, source, size);
    return TRUE;
}
uint32_t KantoBattleSendFinished(void) { return sBattle.outgoing.size == 0; }
uint32_t KantoBattleReceived(void) { return sBattle.received; }
void KantoBattleResetReceived(uint32_t mask) { sBattle.received &= ~mask; }
uint32_t kanto_battle_block_size(void) { return sizeof(struct BattleBlock); }
uint32_t kanto_battle_out_ptr(void) { return KantoBattleIsActive() && sBattle.outgoing.size ? (uint32_t)(uintptr_t)&sBattle.outgoing : 0; }
uint32_t kanto_battle_in_ptr(void) { return KantoBattleIsActive() ? (uint32_t)(uintptr_t)&sBattle.incoming : 0; }
int32_t kanto_battle_ack(uint32_t serial)
{
    if (!KantoBattleIsActive() || !sBattle.outgoing.size || serial != sBattle.outgoing.serial) return -1;
    sBattle.outgoing.size = 0;
    return 0;
}
int32_t kanto_battle_deliver(void)
{
    struct BattleBlock *block = &sBattle.incoming;
    if (!KantoBattleIsActive() || block->player > 1 || !block->size || block->size > BLOCK_BUFFER_SIZE || !block->serial) return -1;
    if (block->serial <= sBattle.received_serial[block->player]) return 1;
    if (block->serial != sBattle.received_serial[block->player] + 1) return -2;
    if (sBattle.received & (1u << block->player)) return -3;
    memset(gBlockRecvBuffer[block->player], 0, BLOCK_BUFFER_SIZE);
    memcpy(gBlockRecvBuffer[block->player], block->data, block->size);
    sBattle.received_serial[block->player] = block->serial;
    sBattle.received |= 1u << block->player;
    return 0;
}
void KantoBattleFinish(void)
{
    sBattle.phase = 3;
    gMain.callback1 = NULL;
    SetMainCallback2(BattleIdle);
}
uint32_t kanto_battle_read(uint32_t key, uint32_t battler)
{
    if (key == 0) return gMain.inBattle;
    if (key == 1) return gBattleOutcome;
    if (key == 2) return gBattleTypeFlags;
    if (key == 3) return gBattleControllerExecFlags;
    if (key == 4) return gBattlersCount;
    if (key == 13) return gPartyMenu.slotId;
    if (key == 14) return gPlayerPartyCount;
    if (key == 15) return battler < PARTY_SIZE ? GetMonData(&gPlayerParty[battler], MON_DATA_HP) : UINT32_MAX;
    if (key == 16) return gBattleTerrain;
    if (battler >= MAX_BATTLERS_COUNT) return UINT32_MAX;
    if (key == 5) return gBattleBufferA[battler][0];
    if (key == 6) return gBattleMons[battler].species;
    if (key == 7) return gBattleMons[battler].hp;
    if (key == 8) return gBattleMons[battler].level;
    if (key >= 9 && key < 13) return gBattleMons[battler].moves[key - 9];
    return UINT32_MAX;
}
