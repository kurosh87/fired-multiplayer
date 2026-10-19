/* Frame coroutines stay entirely inside WASM. Binaryen replaces these four
 * temporary imports with its own control functions at link time. Separate C
 * and Asyncify stacks live in canonical linear memory, so a suspended map-load
 * callback survives hashing, unrelated ABI calls and checkpoint restoration.
 * See Binaryen src/passes/Asyncify.cpp, pure-WASM runtime API. */
#include "kanto_scheduler.h"
#include "kanto_platform.h"

#define ASYNC_API(name) __attribute__((import_module("asyncify"), import_name(name)))
ASYNC_API("start_unwind") void KantoStartUnwind(uint32_t *);
ASYNC_API("stop_unwind") void KantoStopUnwind(void);
ASYNC_API("start_rewind") void KantoStartRewind(uint32_t *);
ASYNC_API("stop_rewind") void KantoStopRewind(void);

static uint8_t sGameStack[1024 * 1024] __attribute__((aligned(16)));
static uint8_t sAsyncStack[256 * 1024] __attribute__((aligned(16)));
static uint32_t sGameSP;
static uint32_t sAsyncData[2];
static uint32_t sSuspended;
static uint32_t sPhase;
static uint32_t sResetRequested;
extern void KantoRunGameStack(uint32_t *stack_pointer);

void KantoSchedulerInit(void)
{
    sGameSP = (uint32_t)(uintptr_t)(sGameStack + sizeof(sGameStack));
    sSuspended = 0;
    sPhase = 0;
    sResetRequested = 0;
    sAsyncData[0] = sAsyncData[1] = 0;
}

__attribute__((noinline)) void KantoSchedulerRequestReset(void)
{
    if (sPhase != 0) __builtin_trap();
    sResetRequested = 1;
    sAsyncData[0] = (uint32_t)(uintptr_t)sAsyncStack;
    sAsyncData[1] = (uint32_t)(uintptr_t)(sAsyncStack + sizeof(sAsyncStack));
    sPhase = 1;
    KantoStartUnwind(sAsyncData);
}

/* Calls to Asyncify's control API exclude these runtime functions from its
 * instrumentation. Do not inline them into game code or instrument the
 * assembly stack-switch wrapper. The game entry itself IS instrumented. */
__attribute__((noinline)) void KantoYieldFrame(void)
{
    if (sPhase == 2)
    {
        KantoStopRewind();
        sPhase = 0;
        KantoPlatformFrameBegin();
        return;
    }
    if (sPhase != 0) __builtin_trap();
    KantoPlatformFrameEnd();
    sAsyncData[0] = (uint32_t)(uintptr_t)sAsyncStack;
    sAsyncData[1] = (uint32_t)(uintptr_t)(sAsyncStack + sizeof(sAsyncStack));
    sPhase = 1;
    KantoStartUnwind(sAsyncData);
}

__attribute__((noinline)) int32_t KantoSchedulerStep(void)
{
    if (sSuspended) { sPhase = 2; KantoStartRewind(sAsyncData); }
    /* A resumed outer frame can finish before the next hardware VBlank. */
    for (uint32_t attempt = 0; attempt < 2; attempt++)
    {
        KantoRunGameStack(&sGameSP);
        if (sPhase == 1)
        {
            KantoStopUnwind();
            sPhase = 0;
            sSuspended = 1;
            if (sResetRequested) return 1; /* Reboot only after the game stack unwinds. */
            return KantoSchedulerValidate();
        }
        if (sPhase != 0) return -1;
        sSuspended = 0;
    }
    return -1; /* Every game frame must reach a hardware frame boundary. */
}

int32_t KantoSchedulerValidate(void)
{
    uintptr_t low = (uintptr_t)sGameStack;
    uintptr_t high = low + sizeof(sGameStack);
    uintptr_t async_low = (uintptr_t)sAsyncStack;
    uintptr_t async_high = async_low + sizeof(sAsyncStack);
    if (sSuspended == 0 && sPhase == 0 && sGameSP == high
        && sAsyncData[0] == 0 && sAsyncData[1] == 0) return 0; /* Boot boundary. */
    if (sSuspended != 1 || sPhase != 0 || sGameSP < low || sGameSP > high || (sGameSP & 15)
        || sAsyncData[0] < async_low || sAsyncData[0] > async_high
        || sAsyncData[1] != async_high) return -1;
    return 0;
}
