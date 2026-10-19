#ifndef KANTO_DMA_H
#define KANTO_DMA_H
#include <stdint.h>

/* Timing values match the GBA control register. Special/FIFO/capture timing is
 * deliberately unsupported until the audio/video controllers exist. */
enum KantoDmaTiming { KANTO_DMA_NOW = 0, KANTO_DMA_VBLANK = 1, KANTO_DMA_HBLANK = 2 };
enum KantoDmaResult { KANTO_DMA_OK = 0, KANTO_DMA_INVALID = -1, KANTO_DMA_UNSUPPORTED = -2 };
void KantoDmaBindRegisters(uint8_t *registers, uint32_t size);

int32_t KantoDmaConfigure(uint32_t channel, const void *source,
                         void *destination, uint32_t control);
/* Original game's DmaSet macro uses this checked wrapper. */
void KantoDmaSet(uint32_t channel, const void *source,
                 void *destination, uint32_t control);
void KantoDmaStop(uint32_t channel);
/* Invoke at actual scanline/blanking boundaries, in hardware channel order. */
void KantoDmaTrigger(uint32_t timing);

#endif
