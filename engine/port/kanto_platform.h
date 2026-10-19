#ifndef KANTO_PLATFORM_H
#define KANTO_PLATFORM_H
#include <stdint.h>

/* These operations must be supplied by the real GBA compatibility layer.
 * There are intentionally no fallback implementations: unresolved symbols must
 * fail linking, not silently turn hardware behavior into a successful no-op. */
struct KantoMemoryView { uint8_t *bytes; uint32_t size; };
int32_t KantoPlatformBoot(uint32_t seed, uint32_t has_save);
int32_t KantoPlatformWarmReset(void);
void KantoPlatformFrameBegin(void);
void KantoPlatformFrameEnd(void);
void KantoPlatformSetButtons(uint32_t buttons);
void KantoPlatformEntropyStart(void);
uint16_t KantoPlatformEntropyRead(void);
struct KantoMemoryView KantoPlatformFlash(void);
/* Serialize all canonical game state, excluding rendering/audio output and
 * the serialization buffer itself. Must be independent of locale/host time. */
struct KantoMemoryView KantoPlatformSerializeState(void);
int32_t KantoPlatformAfterRestore(void);
int32_t KantoPlatformRender(void);
struct KantoMemoryView KantoPlatformFramebuffer(void);
#endif
