/* Compiled inside the original start_menu.c; preserve the actual menu rules
 * for normal fields, Safari Zone, Union Room and physical-link contexts. */
uint32_t KantoGameStartMenuAllowsSave(void)
{
    u8 count = sNumStartMenuItems;
    u8 order[MAX_STARTMENU_ITEMS];
    memcpy(order, sStartMenuOrder, sizeof(order));
    SetUpStartMenu();
    bool32 allowed = FALSE;
    for (u32 i = 0; i < sNumStartMenuItems; i++)
        if (sStartMenuOrder[i] == STARTMENU_SAVE) allowed = TRUE;
    sNumStartMenuItems = count;
    memcpy(sStartMenuOrder, order, sizeof(order));
    return allowed;
}
