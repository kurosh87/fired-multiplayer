#include "global.h"
#include "main.h"
#include "pokemon.h"
#include "link.h"
#include "load_save.h"
#include "save.h"
#include "overworld.h"
#include "trade.h"
#include "trade_scene.h"
#include "mail.h"
#include "pokedex.h"
#include "characters.h"
#include "quest_log.h"
#include "scanline_effect.h"
#include "constants/species.h"
#include "constants/pokemon.h"
#include "constants/items.h"
#include "../include/kanto_abi.h"
#include "kanto_exchange.h"

#define PACKET_MAGIC 0x4b505431u
extern void QuestLog_StartRecordingInputsAfterDeferredEvent(void);
struct KantoPartyPacket {
    uint32_t magic;
    uint32_t abi;
    uint32_t count;
    struct LinkPlayer player;
    struct Pokemon party[PARTY_SIZE];
    struct Mail mail[PARTY_SIZE];
    uint8_t gift_ribbons[GIFT_RIBBONS_COUNT];
};
static struct {
    uint32_t phase;
    struct KantoPartyPacket outgoing;
    struct KantoPartyPacket incoming;
    uint8_t text[POKEMON_NAME_LENGTH + 1];
} sExchange;

_Static_assert(sizeof(struct Pokemon) == 100, "Review cross-version Pokemon layout");
_Static_assert(sizeof(struct LinkPlayer) == 28, "Review cross-version link metadata");
_Static_assert(sizeof(struct Mail) == 36, "Review cross-version mail layout");
_Static_assert(sizeof(struct SaveBlock1) == 0x3d68, "Review original SaveBlock1 ABI");
_Static_assert(sizeof(struct SaveBlock2) == 0xf24, "Review original SaveBlock2 ABI");
_Static_assert(offsetof(struct SaveBlock1, mail) == 0x2cd0, "Review original mail offset");
_Static_assert(offsetof(struct SaveBlock1, giftRibbons) == 0x309c, "Review original ribbon offset");

static void ExchangeIdle(void) {}

static bool32 ValidMon(struct Pokemon *mon)
{
    /* GetMonData performs the original decryption and checksum check. Invalid
     * encrypted records become bad eggs there; never use their species as an
     * index or let an invalid record enter the original trade scene. */
    uint32_t species = GetMonData(mon, MON_DATA_SPECIES);
    if (GetMonData(mon, MON_DATA_SANITY_IS_BAD_EGG)
        || !GetMonData(mon, MON_DATA_SANITY_HAS_SPECIES)
        || species == SPECIES_NONE || species >= NUM_SPECIES) return FALSE;
    uint32_t level = GetMonData(mon, MON_DATA_LEVEL);
    uint32_t max_hp = GetMonData(mon, MON_DATA_MAX_HP);
    uint32_t mail = GetMonData(mon, MON_DATA_MAIL);
    return level >= 1 && level <= MAX_LEVEL && max_hp > 0
        && GetMonData(mon, MON_DATA_HP) <= max_hp && (mail == MAIL_NONE || mail < PARTY_SIZE);
}

static bool32 ValidParty(struct Pokemon *party, uint32_t count)
{
    if (!count || count > PARTY_SIZE) return FALSE;
    for (uint32_t i = 0; i < count; i++) if (!ValidMon(&party[i])) return FALSE;
    return TRUE;
}

int32_t kanto_exchange_open(void)
{
    if (sExchange.phase != KANTO_EXCHANGE_CLOSED || kanto_frame() != 0) return -1;
    SetSaveBlocksPointers();
    if (LoadGameSave(SAVE_NORMAL) != SAVE_STATUS_OK || !ValidParty(gPlayerParty, gPlayerPartyCount))
    {
        sExchange.phase = KANTO_EXCHANGE_FAILED;
        return -2;
    }
    SaveQuestLogData(); /* Original ordering/cursor setup for the loaded log. */
    /* Normal field initialization sets the unused wave-task sentinel before
     * a trade. A fresh service core must do the same: the move summary's
     * ScanlineEffect_Stop must not mistake evolution task zero for a wave. */
    ScanlineEffect_Clear();
    gMain.callback1 = NULL;
    SetMainCallback2(ExchangeIdle);
    gSoftResetDisabled = TRUE;
    sExchange.phase = KANTO_EXCHANGE_OPEN;
    return 0;
}

uint32_t kanto_exchange_phase(void) { return sExchange.phase; }
uint32_t kanto_exchange_abi_version(void) { return KANTO_EXCHANGE_ABI; }
uint32_t kanto_exchange_party_count(void) { return sExchange.phase ? gPlayerPartyCount : 0; }
uint32_t kanto_exchange_mon_size(void) { return sizeof(struct Pokemon); }
uint32_t kanto_exchange_mon_text_size(void) { return sizeof(sExchange.text); }
uint32_t kanto_exchange_mon_text_ptr(uint32_t slot, uint32_t kind)
{
    if (!sExchange.phase || slot >= gPlayerPartyCount || slot >= PARTY_SIZE || kind > 1) return 0;
    memset(sExchange.text, EOS, sizeof(sExchange.text));
    if (kind == 0) GetMonData(&gPlayerParty[slot], MON_DATA_NICKNAME, sExchange.text);
    else GetSpeciesName(sExchange.text, GetMonData(&gPlayerParty[slot], MON_DATA_SPECIES));
    return (uint32_t)(uintptr_t)sExchange.text;
}
uint32_t kanto_exchange_mon_ptr(uint32_t slot)
{
    return sExchange.phase && slot < gPlayerPartyCount && slot < PARTY_SIZE
        ? (uint32_t)(uintptr_t)&gPlayerParty[slot] : 0;
}
uint32_t kanto_exchange_mon_field(uint32_t slot, uint32_t key)
{
    static const uint8_t fields[] = {
        MON_DATA_PERSONALITY, MON_DATA_OT_ID, MON_DATA_SPECIES, MON_DATA_LEVEL,
        MON_DATA_HP, MON_DATA_MAX_HP, MON_DATA_HELD_ITEM, MON_DATA_FRIENDSHIP,
        MON_DATA_IS_EGG, MON_DATA_CHECKSUM, MON_DATA_SANITY_IS_BAD_EGG,
        MON_DATA_MOVE1, MON_DATA_MOVE2, MON_DATA_MOVE3, MON_DATA_MOVE4,
        MON_DATA_PP1, MON_DATA_PP2, MON_DATA_PP3, MON_DATA_PP4
    };
    if (!sExchange.phase || slot >= gPlayerPartyCount || slot >= PARTY_SIZE || key >= ARRAY_COUNT(fields))
        return UINT32_MAX;
    return GetMonData(&gPlayerParty[slot], fields[key]);
}
uint32_t kanto_exchange_packet_size(void) { return sizeof(struct KantoPartyPacket); }
uint32_t kanto_exchange_receive_ptr(void)
{
    return sExchange.phase == KANTO_EXCHANGE_OPEN ? (uint32_t)(uintptr_t)&sExchange.incoming : 0;
}
uint32_t kanto_exchange_packet_ptr(void)
{
    if (sExchange.phase != KANTO_EXCHANGE_OPEN || !ValidParty(gPlayerParty, gPlayerPartyCount)) return 0;
    memset(&sExchange.outgoing, 0, sizeof(sExchange.outgoing));
    sExchange.outgoing.magic = PACKET_MAGIC;
    sExchange.outgoing.abi = KANTO_EXCHANGE_ABI;
    sExchange.outgoing.count = gPlayerPartyCount;
    gLinkType = LINKTYPE_TRADE;
    LocalLinkPlayerToBlock(); /* Original identity, version and progress flags. */
    sExchange.outgoing.player = gLocalLinkPlayer;
    memcpy(sExchange.outgoing.party, gPlayerParty, sizeof(gPlayerParty));
    memcpy(sExchange.outgoing.mail, gSaveBlock1Ptr->mail, sizeof(sExchange.outgoing.mail));
    memcpy(sExchange.outgoing.gift_ribbons, gSaveBlock1Ptr->giftRibbons, GIFT_RIBBONS_COUNT);
    return (uint32_t)(uintptr_t)&sExchange.outgoing;
}

static bool32 InstallPeer(void)
{
    struct KantoPartyPacket *peer = &sExchange.incoming;
    uint32_t version = peer->player.version & 0xff;
    bool32 terminated = FALSE;
    for (uint32_t i = 0; i < sizeof(peer->player.name); i++)
        if (peer->player.name[i] == EOS) terminated = TRUE;
    if (peer->magic != PACKET_MAGIC || peer->abi != KANTO_EXCHANGE_ABI
        || (version != VERSION_FIRE_RED && version != VERSION_LEAF_GREEN)
        || !ValidParty(peer->party, peer->count)
        || !terminated) return FALSE;
    /* Local cable index stays zero in each isolated core. The real online
     * peer is represented by its original metadata; no physical RFU/cable
     * connection, interrupt or successful hardware transfer is fabricated. */
    if (gWirelessCommType != 0 || GetMultiplayerId() != 0) return FALSE;
    gLinkPlayers[0] = sExchange.outgoing.player;
    gLinkPlayers[1] = peer->player;
    ConvertLinkPlayerName(&gLinkPlayers[0]);
    ConvertLinkPlayerName(&gLinkPlayers[1]);
    memcpy(gEnemyParty, peer->party, sizeof(gEnemyParty));
    gEnemyPartyCount = peer->count;
    memcpy(gLinkPartnerMail, peer->mail, sizeof(gLinkPartnerMail));
    return TRUE;
}

int32_t kanto_exchange_check(uint32_t slot, uint32_t peer_slot)
{
    if (sExchange.phase != KANTO_EXCHANGE_OPEN || slot >= gPlayerPartyCount || slot >= PARTY_SIZE
        || !ValidParty(gPlayerParty, gPlayerPartyCount)
        || !InstallPeer() || peer_slot >= sExchange.incoming.count || peer_slot >= PARTY_SIZE) return -3;
    return KantoGameCheckTrade(slot, peer_slot);
}

int32_t kanto_exchange_start(uint32_t slot, uint32_t peer_slot)
{
    int32_t result = kanto_exchange_check(slot, peer_slot);
    if (result != 0) return result;
    if (KantoGameMergeGiftRibbons(sExchange.incoming.gift_ribbons, GIFT_RIBBONS_COUNT) != 0) return -4;
    gMapHeader = *Overworld_GetMapHeaderByGroupAndId(gSaveBlock1Ptr->location.mapGroup, gSaveBlock1Ptr->location.mapNum);
    gSelectedTradeMonPositions[0] = slot;
    gSelectedTradeMonPositions[1] = peer_slot + PARTY_SIZE;
    sExchange.phase = KANTO_EXCHANGE_RUNNING;
    SetMainCallback2(CB2_LinkTrade);
    return 0;
}

uint32_t KantoExchangeIsTrade(void) { return sExchange.phase == KANTO_EXCHANGE_RUNNING; }
void KantoExchangeFinishTrade(void)
{
    if (!KantoExchangeIsTrade()) __builtin_trap();
    /* The original scene has completed the swap, mail/ribbons/Pokedex and
     * evolution/move learning. Use the original cartridge save serializer.
     * Browser lobby trades return to the saved map, not a cable-club warp. */
    /* Cable-club scripts normally flush the deferred link event on exit.
     * The browser lobby has no physical club exit, so call that same game
     * routine here and close its recording before writing the staged save. */
    QuestLog_StartRecordingInputsAfterDeferredEvent();
    SaveQuestLogData();
    sExchange.phase = ValidParty(gPlayerParty, gPlayerPartyCount)
        && TrySavingData(SAVE_NORMAL) == SAVE_STATUS_OK ? KANTO_EXCHANGE_DONE : KANTO_EXCHANGE_FAILED;
    SetMainCallback2(ExchangeIdle);
}
