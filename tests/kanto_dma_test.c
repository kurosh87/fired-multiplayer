#include <assert.h>
#include "../engine/port/kanto_dma.h"
#include "../engine/port/kanto_hardware.h"

static void Immediate(void)
{
    uint16_t source[] = {11, 22, 33, 44};
    uint16_t destination[] = {0, 0, 0, 0};
    KantoHardwareReset();
    KantoDmaSet(3, source, destination, 0x80000004);
    for (unsigned i = 0; i < 4; i++) assert(destination[i] == source[i]);
    assert(!(gKantoHardware.registers[0xdf] & 0x80));
    KantoDmaSet(2, &source[3], destination, 0x80800004);
    for (unsigned i = 0; i < 4; i++) assert(destination[i] == source[3-i]);
    KantoDmaSet(1, &source[2], &destination[3], 0x81200004);
    for (unsigned i = 0; i < 4; i++) assert(destination[i] == 33);
    KantoDmaSet(0, source, destination, 0x80400004);
    assert(destination[0] == 44);
    uint32_t words[] = {0x12345678, 0xabcdef01};
    uint32_t output[] = {0, 0};
    KantoDmaSet(3, words, output, 0xc4000002);
    assert(output[0] == words[0] && output[1] == words[1]);
    assert(gKantoHardware.registers[0x203] & 0x08); /* DMA3 IRQ pending. */
}

static void Scheduled(void)
{
    uint16_t source[] = {10, 20, 30, 40, 50, 60};
    uint16_t output[] = {0, 0};
    KantoHardwareReset();
    KantoDmaSet(0, source, output, 0xa2600002); /* HBlank, repeat, destination reload. */
    KantoDmaTrigger(KANTO_DMA_VBLANK);
    assert(output[0] == 0 && output[1] == 0);
    KantoDmaTrigger(KANTO_DMA_HBLANK);
    assert(output[0] == 10 && output[1] == 20);
    KantoDmaTrigger(KANTO_DMA_HBLANK);
    assert(output[0] == 30 && output[1] == 40);
    KantoDmaStop(0);
    KantoDmaTrigger(KANTO_DMA_HBLANK);
    assert(output[0] == 30 && output[1] == 40);
    KantoDmaSet(1, source, output, 0x90000002); /* One VBlank transfer. */
    KantoDmaTrigger(KANTO_DMA_VBLANK);
    assert(output[0] == 10 && output[1] == 20);
    output[0] = 99;
    KantoDmaTrigger(KANTO_DMA_VBLANK);
    assert(output[0] == 99);
    KantoDmaSet(1, source, output, 0x92000000);
    assert(gKantoHardware.dma[1].units == 0x4000);
    KantoDmaStop(1);
    KantoDmaSet(3, source, output, 0x92000000);
    assert(gKantoHardware.dma[3].units == 0x10000);
    KantoDmaStop(3);
}

static void Rejected(void)
{
    uint32_t source = 1, output = 7;
    KantoHardwareReset();
    assert(KantoDmaConfigure(4, &source, &output, 0x80000001) == KANTO_DMA_INVALID);
    assert(KantoDmaConfigure(1, &source, &output, 0xb6000001) == KANTO_DMA_UNSUPPORTED);
    assert(KantoDmaConfigure(1, &source, &output, 0x81800001) == KANTO_DMA_INVALID);
    assert(KantoDmaConfigure(1, 0, &output, 0x80000001) == KANTO_DMA_INVALID);
    assert(output == 7);
    assert(gKantoHardware.dma[1].control == 0);
}

static void BoundRegisters(void)
{
    _Alignas(4) uint8_t registers[0x400] = {0};
    uint32_t source = 123, destination = 0;
    KantoHardwareReset();
    KantoDmaBindRegisters(registers, sizeof(registers));
    KantoDmaSet(3, &source, &destination, 0xc4000001);
    assert(destination == 123);
    assert(registers[0x203] & 8);
    assert(gKantoHardware.registers[0x203] == 0);
    KantoDmaBindRegisters(gKantoHardware.registers, sizeof(gKantoHardware.registers));
}

int main(void)
{
    Immediate();
    Scheduled();
    Rejected();
    BoundRegisters();
    return 0;
}
