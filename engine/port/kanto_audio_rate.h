#ifndef KANTO_AUDIO_RATE_H
#define KANTO_AUDIO_RATE_H
/* Experimental compiler pre-include, confined to the two audio source units.
 * Keep 701 samples per original GBA frame; synthesize pitch using the nearest
 * integer rate. Browser output uses the exact rational rate from the ABI. */
#include "global.h"
#include "gba/m4a_internal.h"
#undef PORTABLE_AUDIO_RATE
#define PORTABLE_AUDIO_RATE 41869
#endif
