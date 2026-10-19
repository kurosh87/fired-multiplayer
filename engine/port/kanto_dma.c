#include "kanto_dma.h"
#include "kanto_hardware.h"

#define DMA_ENABLE 0x8000u
#define DMA_REPEAT 0x0200u
#define DMA_IRQ 0x4000u
#define DMA_WORD 0x0400u
static uint8_t *sRegisters = gKantoHardware.registers;

void KantoDmaBindRegisters(uint8_t *registers, uint32_t size)
{
    if (!registers || size != 0x400 || ((uintptr_t)registers & 3))
        __builtin_trap();
    sRegisters = registers;
}

static void Write16(uint32_t offset, uint16_t value)
{
    sRegisters[offset] = (uint8_t)value;
    sRegisters[offset + 1] = (uint8_t)(value >> 8);
}

static uint16_t Read16(uint32_t offset)
{
    return (uint16_t)(sRegisters[offset] | (uint16_t)sRegisters[offset + 1] << 8);
}

static void Write32(uint32_t offset, uint32_t value)
{
    Write16(offset, (uint16_t)value);
    Write16(offset + 2, (uint16_t)(value >> 16));
}

static uintptr_t Advance(uintptr_t address, uint32_t mode, uint32_t width)
{
    if (mode == 1)
        return address - width;
    if (mode == 2)
        return address;
    return address + width;
}

static void Transfer(uint32_t channel)
{
    struct KantoDmaChannel *dma = &gKantoHardware.dma[channel];
    uint32_t offset = 0xb0 + 12 * channel;
    uint32_t source_mode = (dma->control >> 7) & 3;
    uint32_t destination_mode = (dma->control >> 5) & 3;
    uint32_t width = dma->control & DMA_WORD ? 4 : 2;
    for (uint32_t i = 0; i < dma->units; i++)
    {
        /* Volatile prevents memcpy substitution: fixed/decrementing and
         * overlapping transfers must retain the hardware's sequential order. */
        if (width == 4)
            *(volatile uint32_t *)dma->destination = *(volatile const uint32_t *)dma->source;
        else
            *(volatile uint16_t *)dma->destination = *(volatile const uint16_t *)dma->source;
        dma->source = Advance(dma->source, source_mode, width);
        dma->destination = Advance(dma->destination, destination_mode, width);
    }
    if (dma->control & DMA_IRQ)
        Write16(0x202, (uint16_t)(Read16(0x202) | (1u << (8 + channel))));
    if ((dma->control & DMA_REPEAT) && ((dma->control >> 12) & 3) != KANTO_DMA_NOW)
    {
        if (destination_mode == 3)
            dma->destination = dma->initial_destination;
    }
    else
    {
        dma->control &= (uint16_t)~DMA_ENABLE;
        Write16(offset + 10, dma->control);
    }
}

int32_t KantoDmaConfigure(uint32_t channel, const void *source,
                         void *destination, uint32_t control)
{
    if (channel >= 4)
        return KANTO_DMA_INVALID;
    uint16_t flags = (uint16_t)(control >> 16);
    if (flags & DMA_ENABLE)
    {
        if (!source || !destination || ((flags >> 7) & 3) == 3)
            return KANTO_DMA_INVALID;
        if (((flags >> 12) & 3) == 3 || (flags & 0x0800))
            return KANTO_DMA_UNSUPPORTED;
    }
    uint32_t width = flags & DMA_WORD ? 4 : 2;
    struct KantoDmaChannel *dma = &gKantoHardware.dma[channel];
    dma->source = (uintptr_t)source & ~(uintptr_t)(width - 1);
    dma->destination = (uintptr_t)destination & ~(uintptr_t)(width - 1);
    dma->initial_destination = dma->destination;
    dma->units = control & (channel == 3 ? 0xffff : 0x3fff);
    if (dma->units == 0)
        dma->units = channel == 3 ? 0x10000 : 0x4000;
    dma->control = flags;
    uint32_t offset = 0xb0 + 12 * channel;
    Write32(offset, (uint32_t)(uintptr_t)source);
    Write32(offset + 4, (uint32_t)(uintptr_t)destination);
    Write32(offset + 8, control);
    if ((flags & DMA_ENABLE) && ((flags >> 12) & 3) == KANTO_DMA_NOW)
        Transfer(channel);
    return KANTO_DMA_OK;
}

void KantoDmaSet(uint32_t channel, const void *source,
                 void *destination, uint32_t control)
{
    if (KantoDmaConfigure(channel, source, destination, control) != KANTO_DMA_OK)
        __builtin_trap();
}

void KantoDmaStop(uint32_t channel)
{
    if (channel >= 4)
        __builtin_trap();
    uint32_t offset = 0xba + 12 * channel;
    uint16_t flags = (uint16_t)(Read16(offset) & ~(DMA_ENABLE | 0x3000 | 0x0800 | DMA_REPEAT));
    gKantoHardware.dma[channel].control = flags;
    Write16(offset, flags);
}

void KantoDmaTrigger(uint32_t timing)
{
    if (timing != KANTO_DMA_VBLANK && timing != KANTO_DMA_HBLANK)
        __builtin_trap();
    for (uint32_t channel = 0; channel < 4; channel++)
    {
        struct KantoDmaChannel *dma = &gKantoHardware.dma[channel];
        /* Honor a direct register disable as well as DmaStop. Direct register
         * enabling/configuration still requires the remaining source audit. */
        if (!(Read16(0xba + 12 * channel) & DMA_ENABLE))
            dma->control &= (uint16_t)~DMA_ENABLE;
        if ((dma->control & DMA_ENABLE) && ((dma->control >> 12) & 3) == timing)
            Transfer(channel);
    }
}
