#include "kanto_hardware.h"

struct KantoHardwareState gKantoHardware;

void KantoHardwareReset(void)
{
    /* Explicit byte stores keep this freestanding; no libc import is needed. */
    volatile uint8_t *bytes = (volatile uint8_t *)&gKantoHardware;
    for (size_t i = 0; i < sizeof(gKantoHardware); i++)
        bytes[i] = 0;
    KantoHardwareSetButtons(0);
}

void KantoHardwareSetButtons(uint32_t buttons)
{
    uint16_t keys = (uint16_t)(~buttons & 0x03ff);
    gKantoHardware.registers[0x130] = (uint8_t)keys;
    gKantoHardware.registers[0x131] = (uint8_t)(keys >> 8);
}
