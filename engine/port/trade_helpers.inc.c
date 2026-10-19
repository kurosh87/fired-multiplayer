/* Compiled inside the pinned trade.c to call its original private rules. */
int32_t KantoGameCheckTrade(uint32_t slot, uint32_t peer_slot)
{
    if (sTradeMenu != NULL) return -10;
    sTradeMenu = AllocZeroed(sizeof(*sTradeMenu));
    if (sTradeMenu == NULL) return -11;
    /* Reuse the original post-receive normalization (notably Shedinja's
     * international nickname). Earlier states only transport the packet. */
    sTradeMenu->bufferPartyState = 21;
    BufferTradeParties();
    int32_t result = CanTradeSelectedMon(gPlayerParty, gPlayerPartyCount, slot);
    if (result != CAN_TRADE_MON)
    {
        Free(sTradeMenu);
        sTradeMenu = NULL;
        return result;
    }
    sTradeMenu->partnerCursorPosition = peer_slot;
    u8 alive[PARTY_SIZE] = {0};
    for (uint32_t i = 0; i < gPlayerPartyCount; i++)
        alive[i] = GetMonData(&gPlayerParty[i], MON_DATA_SPECIES_OR_EGG) != SPECIES_EGG
            && GetMonData(&gPlayerParty[i], MON_DATA_HP) != 0;
    u8 validity = CheckValidityOfTradeMons(alive, gPlayerPartyCount, slot);
    Free(sTradeMenu);
    sTradeMenu = NULL;
    if (validity == PARTNER_MON_INVALID) return CANT_TRADE_INVALID_MON;
    if (validity != BOTH_MONS_VALID) return CANT_TRADE_LAST_MON;
    return CAN_TRADE_MON;
}

int32_t KantoGameMergeGiftRibbons(const uint8_t *ribbons, uint32_t size)
{
    if (size != GIFT_RIBBONS_COUNT || sTradeMenu != NULL) return -1;
    sTradeMenu = AllocZeroed(sizeof(*sTradeMenu));
    if (sTradeMenu == NULL) return -2;
    memcpy(sTradeMenu->giftRibbons, ribbons, size);
    SaveTradeGiftRibbons();
    Free(sTradeMenu);
    sTradeMenu = NULL;
    return 0;
}
