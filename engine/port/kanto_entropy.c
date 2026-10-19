#include "kanto_entropy.h"

void KantoEntropyInit(struct KantoEntropyCounter *counter, uint32_t seed)
{
    /* Fold all 32 trusted seed bits into the original 16-bit entropy input.
     * Unsigned operations have the same defined behavior on both hosts.
     * This is seed diffusion, not a replacement for the game's own PRNG. */
    seed ^= seed >> 16;
    seed *= 0x7feb352du;
    seed ^= seed >> 15;
    seed *= 0x846ca68bu;
    seed ^= seed >> 16;
    counter->origin = (uint16_t)seed;
    counter->value = counter->origin;
}

void KantoEntropyStart(struct KantoEntropyCounter *counter) { counter->value = counter->origin; }
void KantoEntropyAdvance(struct KantoEntropyCounter *counter, uint32_t frames)
{
    /* GBA frame: 228 lines * 1232 clocks. Timer 1 uses the 1-clock setting.
     * Modulo-2^32 multiplication preserves the low 16 bits even for large
     * frame counts. There is no subframe instruction timing in this C port. */
    counter->value = (uint16_t)(counter->value + frames * 280896u);
}
