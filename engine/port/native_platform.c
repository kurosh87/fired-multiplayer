/* Host boundary for the pinned portable FireRed source. Game code, BIOS,
 * graphics and music remain compiled C. No host imports or wall clock. */
#include "global.h"
#include "main.h"
#include "random.h"
#include "platform.h"
#include "platform/framedraw.h"
#include "platform/dma.h"
#include "libgcnmultiboot.h"
#include "kanto_platform.h"
#include "kanto_hardware.h"
#include "kanto_dma.h"
#include "kanto_scheduler.h"
#include "kanto_entropy.h"
#include <stdarg.h>

extern unsigned char FLASH_BASE[131072];
extern unsigned char __data_end;
extern unsigned char __heap_base;
extern void KantoRestoreInitialMemory(void);

/* The two-pass linker verifies .rodata/.data/.bss boundaries and supplies the
 * mutable start as a code constant. The first layout pass uses the full static
 * region and is never executed. Assets are pinned by the artifact SHA-256;
 * the per-batch digest includes all mutable C data, stacks, registers and flash.
 * Output, read-only assets and serialization scratch are excluded. */
#define STATIC_BASE 1048576u
#ifndef KANTO_MUTABLE_BASE
#define KANTO_MUTABLE_BASE STATIC_BASE
#endif
struct KantoOutput {
    uint16_t video[240 * 160];
    uint32_t rgba[240 * 160];
    float audio[4096];
    uint32_t audio_samples;
    char diagnostic[1024];
};
static struct KantoOutput sOutput;
static uint32_t sButtons;
static uint32_t sBooted;
static uint32_t sColdBoot;
static struct KantoEntropyCounter sEntropy;

#ifdef FIRERED
const char RomHeaderGameCode[4] = {'B', 'P', 'R', 'E'};
#else
const char RomHeaderGameCode[4] = {'B', 'P', 'G', 'E'};
#endif
const char RomHeaderSoftwareVersion = 1;

void KantoPlatformLog(const char *text)
{
    strncpy(sOutput.diagnostic, text, sizeof(sOutput.diagnostic) - 1);
    sOutput.diagnostic[sizeof(sOutput.diagnostic) - 1] = 0;
}
uint32_t kanto_diagnostic_ptr(void) { return (uint32_t)(uintptr_t)sOutput.diagnostic; }
uint32_t kanto_diagnostic_size(void) { return sizeof(sOutput.diagnostic); }
uint32_t kanto_immutable_ptr(void) { return STATIC_BASE; }
uint32_t kanto_immutable_size(void) { return KANTO_MUTABLE_BASE - STATIC_BASE; }

void SDL_Log(const char *format, ...)
{
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(sOutput.diagnostic, sizeof(sOutput.diagnostic), format, arguments);
    va_end(arguments);
}

u32 umul3232H32(u32 left, u32 right) { return (u32)(((uint64_t)left * right) >> 32); }
s32 Div(s32 number, s32 denominator)
{
    if (!denominator) __builtin_trap();
    if (number == INT32_MIN && denominator == -1) return INT32_MIN;
    return number / denominator;
}

void RegisterRamReset(u32 flags)
{
    /* A fresh WASM instance supplies initialized game data and zeroed BSS.
     * Warm CPU/RAM reset needs an explicit reset boundary and is not silently
     * treated as a successful hardware reset. */
    if ((flags & (RESET_EWRAM | RESET_IWRAM)) && !sColdBoot) __builtin_trap();
    if (flags & RESET_PALETTE) memset(PLTT, 0, PLTT_SIZE);
    if (flags & RESET_VRAM) memset((void *)VRAM, 0, VRAM_SIZE);
    if (flags & RESET_OAM) memset(OAM, 0, OAM_SIZE);
    if (flags & RESET_SIO_REGS) memset(REG_BASE + 0x120, 0, 0x40);
    if (flags & RESET_SOUND_REGS) memset(REG_BASE + 0x60, 0, 0x50);
    if (flags & RESET_REGS)
    {
        memset(REG_BASE, 0, 0x60);
        memset(REG_BASE + 0xb0, 0, 0x30);
        memset(REG_BASE + 0x100, 0, 0x10);
        memset(REG_BASE + 0x200, 0, 0x10);
        REG_DISPCNT = DISPCNT_FORCED_BLANK;
        REG_KEYINPUT = 0x3ff;
    }
    sColdBoot = 0;
}

void SoftReset(u32 flags) { (void)flags; KantoSchedulerRequestReset(); }
void Platform_ExitApplication(void) { KantoPlatformLog("Exit through the verified game session."); __builtin_trap(); }

/* The browser has no physical GameCube/cartridge peer. Expose a disconnected
 * device to the copyright-screen probe; never report a successful download. */
void GameCubeMultiBoot_Init(struct GcmbStruct *device) { memset(device, 0, sizeof(*device)); REG_SIOCNT = SIO_32BIT_MODE; }
void GameCubeMultiBoot_Main(struct GcmbStruct *device) { device->gcmb_field_2 = 0; }
void GameCubeMultiBoot_HandleSerialInterrupt(struct GcmbStruct *device) { device->gcmb_field_0 = 0; device->gcmb_field_2 = 0; }
void GameCubeMultiBoot_Quit(void) { REG_SIOCNT = 0; REG_RCNT = 0; }
void GameCubeMultiBoot_ExecuteProgram(struct GcmbStruct *device) { (void)device; __builtin_trap(); }
int MultiBoot(struct MultiBootParam *parameters) { (void)parameters; return 1; }

void DmaSet(int channel, const void *source, void *destination, u32 control)
{
    KantoDmaSet((uint32_t)channel, source, destination, control);
}
void RunDMAs(u32 timing) { if (timing != DMA_NOW) KantoDmaTrigger(timing); }
void VBlankIntrWait(void) { KantoYieldFrame(); }

u16 Platform_GetKeyInput(void) { return (u16)sButtons; }
bool32 Platform_SkipAudioFrame(void) { return FALSE; }
void Platform_QueueAudio(float *samples, s32 byte_count)
{
    /* The native declaration calls this samplesPerFrame; the sound mixer
     * actually supplies a BYTE count for interleaved float stereo. */
    if (byte_count < 0 || byte_count > sizeof(sOutput.audio)
        || (byte_count % (2 * sizeof(float)))) __builtin_trap();
    memcpy(sOutput.audio, samples, (size_t)byte_count);
    sOutput.audio_samples = (uint32_t)byte_count / sizeof(float);
}
#ifdef KANTO_AUDIO_EXPERIMENT
#include "gba/m4a_internal.h"
/* Output-only extension. Reading audio never advances its mixer or clears
 * samples: all simulation and driver state advance in kanto_step. */
uint32_t kanto_audio_abi_version(void) { return 1; }
uint32_t kanto_audio_ptr(void) { return (uint32_t)(uintptr_t)sOutput.audio; }
uint32_t kanto_audio_samples(void) { return sOutput.audio_samples; }
uint32_t kanto_audio_capacity(void) { return sizeof(sOutput.audio) / sizeof(float); }
uint32_t kanto_audio_channels(void) { return 2; }
uint32_t kanto_audio_mixer_rate(void) { return 41869; }
uint32_t kanto_audio_driver_rate(void) { return SOUND_INFO_PTR ? SOUND_INFO_PTR->pcmFreq : 0; }
double kanto_audio_rate(void) { return 701.0 * 16777216.0 / 280896.0; }
#endif
void Platform_ReadFlash(u16 sector, u32 offset, u8 *destination, u32 size)
{
    if (sector >= 32 || offset > 4096 || size > 4096 - offset) __builtin_trap();
    memcpy(destination, FLASH_BASE + (uint32_t)sector * 4096 + offset, size);
}

int32_t KantoPlatformBoot(uint32_t seed, uint32_t has_save)
{
    if (sBooted || has_save > 1) return -1;
    KantoHardwareReset();
    KantoDmaBindRegisters(REG_BASE, 0x400);
    sButtons = 0;
    sColdBoot = 1;
    sBooted = 1;
    KantoEntropyInit(&sEntropy, seed);
    SeedRng(seed);
    for (uint32_t i = 0; i < 240 * 160; i++) sOutput.rgba[i] = 0xff000000;
    return 0;
}

int32_t KantoPlatformWarmReset(void)
{
    /* The linked initializer restores all game RAM only after its coroutine
     * has unwound. Cartridge flash survives, as it does on the GBA. Scratch
     * and the active ABI-call stack are outside that static RAM region. */
    uint8_t *temporary = &__heap_base;
    uint64_t available = (uint64_t)__builtin_wasm_memory_size(0) * 65536;
    if ((uintptr_t)temporary + sizeof(FLASH_BASE) > available) return -1;
    memcpy(temporary, FLASH_BASE, sizeof(FLASH_BASE));
    KantoRestoreInitialMemory();
    memcpy(FLASH_BASE, temporary, sizeof(FLASH_BASE));
    return 0;
}

void KantoPlatformSetButtons(uint32_t buttons)
{
    sButtons = buttons & 0x3ff;
    REG_KEYINPUT = (u16)(~sButtons & 0x3ff);
}
void KantoPlatformEntropyStart(void)
{
    KantoEntropyStart(&sEntropy);
    REG_TM1CNT_L = sEntropy.value;
    REG_TM1CNT_H = 0x80;
}
uint16_t KantoPlatformEntropyRead(void) { return sEntropy.value; }
void KantoPlatformFrameBegin(void) { REG_VCOUNT = 0; REG_DISPSTAT &= ~DISPSTAT_VBLANK; }
void KantoPlatformFrameEnd(void)
{
    if (REG_TM1CNT_H & 0x80)
    {
        KantoEntropyAdvance(&sEntropy, 1);
        REG_TM1CNT_L = sEntropy.value;
    }
    /* Rendering runs in the frame step on both hosts because this renderer
     * delivers scanline callbacks and HBlank DMA. Exported render is read-only. */
    DrawFrame(sOutput.video);
    REG_VCOUNT = 160;
    REG_DISPSTAT |= DISPSTAT_VBLANK;
    RunDMAs(DMA_VBLANK);
    if ((REG_IME & 1) && (REG_IE & INTR_FLAG_VBLANK)) gIntrTable[4]();
    for (uint32_t i = 0; i < 240 * 160; i++)
    {
        uint32_t color = sOutput.video[i];
        uint32_t red = (color & 31) * 255 / 31;
        uint32_t green = ((color >> 5) & 31) * 255 / 31;
        uint32_t blue = ((color >> 10) & 31) * 255 / 31;
        sOutput.rgba[i] = red | (green << 8) | (blue << 16) | 0xff000000;
    }
}

struct KantoMemoryView KantoPlatformFlash(void) { return (struct KantoMemoryView){FLASH_BASE, sizeof(FLASH_BASE)}; }
struct KantoMemoryView KantoPlatformFramebuffer(void) { return (struct KantoMemoryView){(uint8_t *)sOutput.rgba, sizeof(sOutput.rgba)}; }
int32_t KantoPlatformRender(void) { return sBooted ? 0 : -1; }
int32_t KantoPlatformAfterRestore(void) { return sBooted == 1 ? KantoSchedulerValidate() : -1; }
struct KantoMemoryView KantoPlatformSerializeState(void)
{
    uintptr_t end = (uintptr_t)&__data_end;
    uintptr_t excluded = (uintptr_t)&sOutput;
    uintptr_t scratch = (uintptr_t)&__heap_base;
    uint64_t available = (uint64_t)__builtin_wasm_memory_size(0) * 65536;
    if (KANTO_MUTABLE_BASE < STATIC_BASE || excluded < KANTO_MUTABLE_BASE
        || excluded + sizeof(sOutput) > end || end < KANTO_MUTABLE_BASE
        || scratch < end || scratch + end - KANTO_MUTABLE_BASE > available) __builtin_trap();
    uint32_t first = (uint32_t)(excluded - KANTO_MUTABLE_BASE);
    uint32_t second = (uint32_t)(end - excluded - sizeof(sOutput));
    memcpy((void *)scratch, (const void *)KANTO_MUTABLE_BASE, first);
    memcpy((void *)(scratch + first), (const void *)(excluded + sizeof(sOutput)), second);
    return (struct KantoMemoryView){(uint8_t *)scratch, first + second};
}
