#ifndef KANTO_ENTROPY_H
#define KANTO_ENTROPY_H
#include <stdint.h>

/* Portable replacement for the title screen's Timer 1 entropy source only.
 * It is deliberately not a general, cycle-exact hardware timer emulator.
 * The trusted boot seed supplies the unavailable power-on timing phase;
 * subsequent ticks follow simulated GBA frames, never host time. Keep the
 * complete state in canonical linear memory for checkpoint/replay. */
struct KantoEntropyCounter { uint16_t origin; uint16_t value; };
void KantoEntropyInit(struct KantoEntropyCounter *counter, uint32_t seed);
void KantoEntropyStart(struct KantoEntropyCounter *counter);
void KantoEntropyAdvance(struct KantoEntropyCounter *counter, uint32_t frames);
#endif
