#ifndef KANTO_HARDWARE_H
#define KANTO_HARDWARE_H

#include <stddef.h>
#include <stdint.h>

/* Storage for the hardware-visible regions used by the original game. This is
 * deliberately separate from the frame scheduler and the game globals. Merely
 * writing a DMA/timer/IRQ register does not implement its hardware effects. */
struct SoundInfo;
struct KantoDmaChannel {
    uintptr_t source;
    uintptr_t destination;
    uintptr_t initial_destination;
    uint32_t units;
    uint16_t control;
    uint16_t reserved;
};
struct KantoHardwareState {
    _Alignas(4) uint8_t registers[0x400];
    _Alignas(4) uint8_t palette[0x400];
    _Alignas(4) uint8_t vram[0x18000];
    _Alignas(4) uint8_t oam[0x400];
    uint16_t intr_check;
    uint16_t reserved;
    void *intr_vector;
    struct SoundInfo *sound_info;
    struct KantoDmaChannel dma[4];
};

extern struct KantoHardwareState gKantoHardware;

/* A fresh simulation initializes hardware storage only. This function must not
 * erase an already-loaded save or be called during checkpoint restoration. */
void KantoHardwareReset(void);
/* Protocol button bits match the GBA layout; KEYINPUT is active low. */
void KantoHardwareSetButtons(uint32_t buttons);

_Static_assert(offsetof(struct KantoHardwareState, palette) == 0x400,
               "Palette layout changed");
_Static_assert(offsetof(struct KantoHardwareState, vram) == 0x800,
               "VRAM layout changed");
_Static_assert(offsetof(struct KantoHardwareState, oam) == 0x18800,
               "OAM layout changed");
#ifdef KANTO_WASM
_Static_assert(sizeof(void *) == 4, "The game requires the wasm32 pointer ABI");
_Static_assert(sizeof(struct KantoDmaChannel) == 20, "DMA state layout changed");
_Static_assert(sizeof(struct KantoHardwareState) == 0x18c5c,
               "Hardware state layout changed");
#endif

#endif
