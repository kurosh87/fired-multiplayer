/* Run in CI; local source checking can use clang -fsyntax-only. */
#include <assert.h>
#include "../engine/port/kanto_hardware.h"

int main(void)
{
    KantoHardwareReset();
    assert(gKantoHardware.registers[0x130] == 0xff);
    assert(gKantoHardware.registers[0x131] == 0x03);
    KantoHardwareSetButtons(0x0111); /* A, right and R. */
    assert(gKantoHardware.registers[0x130] == 0xee);
    assert(gKantoHardware.registers[0x131] == 0x02);
    KantoHardwareSetButtons(0xffffffff);
    assert(gKantoHardware.registers[0x130] == 0);
    assert(gKantoHardware.registers[0x131] == 0);
    gKantoHardware.palette[0] = 17;
    gKantoHardware.vram[0] = 23;
    gKantoHardware.oam[0] = 31;
    gKantoHardware.intr_check = 0xffff;
    KantoHardwareSetButtons(0);
    assert(gKantoHardware.palette[0] == 17);
    assert(gKantoHardware.vram[0] == 23);
    assert(gKantoHardware.oam[0] == 31);
    assert(gKantoHardware.intr_check == 0xffff);
    KantoHardwareReset();
    assert(gKantoHardware.palette[0] == 0);
    assert(gKantoHardware.vram[0] == 0);
    assert(gKantoHardware.oam[0] == 0);
    assert(gKantoHardware.intr_check == 0);
    assert(gKantoHardware.intr_vector == 0);
    assert(gKantoHardware.sound_info == 0);
    return 0;
}
