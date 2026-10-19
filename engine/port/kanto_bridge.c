#include "../include/kanto_abi.h"
#include "kanto_platform.h"
#include "kanto_scheduler.h"

extern void AgbMain(void);
extern void KantoGameFrame(void);
static uint32_t sFrame;
static uint32_t sSeed;

uint32_t kanto_abi_version(void) { return KANTO_ABI_VERSION; }

int32_t kanto_boot(uint32_t seed, uint32_t has_save)
{
    int32_t result = KantoPlatformBoot(seed, has_save);
    if (result != 0) return result;
    sFrame = 0;
    sSeed = seed;
    KantoSchedulerInit();
    AgbMain();
    return 0;
}

int32_t kanto_step(uint32_t buttons, uint32_t frames)
{
    if ((buttons & ~KANTO_BUTTON_MASK) != 0 || frames < 1 || frames > 60)
        return -1;
    if (sFrame > UINT32_MAX - frames) return -2;
    for (uint32_t i = 0; i < frames; ++i)
    {
        KantoPlatformSetButtons(buttons);
        int32_t result = KantoSchedulerStep();
        if (result == 1)
        {
            uint32_t frame = sFrame;
            uint32_t seed = sSeed;
            if (KantoPlatformWarmReset() != 0 || kanto_boot(seed, 1) != 0) return -4;
            /* A reset consumes a simulation tick and preserves the verified
             * session's monotonic clock. The game itself starts a fresh boot. */
            sFrame = frame;
        }
        else if (result != 0) return -3;
        ++sFrame;
    }
    return 0;
}

uint32_t kanto_frame(void) { return sFrame; }
uint32_t kanto_flash_ptr(void) { return (uint32_t)(uintptr_t)KantoPlatformFlash().bytes; }
uint32_t kanto_flash_size(void) { return KantoPlatformFlash().size; }
uint32_t kanto_state_ptr(void) { return (uint32_t)(uintptr_t)KantoPlatformSerializeState().bytes; }
uint32_t kanto_state_size(void) { return KantoPlatformSerializeState().size; }
int32_t kanto_after_restore(void) { return KantoPlatformAfterRestore(); }
int32_t kanto_render_frame(void) { return KantoPlatformRender(); }
uint32_t kanto_framebuffer_ptr(void) { return (uint32_t)(uintptr_t)KantoPlatformFramebuffer().bytes; }
uint32_t kanto_framebuffer_size(void) { return KantoPlatformFramebuffer().size; }
