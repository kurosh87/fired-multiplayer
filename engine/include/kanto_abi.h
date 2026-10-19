#ifndef KANTO_ABI_H
#define KANTO_ABI_H

#include <stdint.h>
#define KANTO_ABI_VERSION 1u
#define KANTO_FLASH_BYTES (128u * 1024u)
#define KANTO_BUTTON_MASK 0x03ffu

/* All mutable simulation state must be in linear memory. No wall clock,
 * browser state, host pointers, or unresolved platform imports are permitted.
 * Every public call returns at a frame boundary with no live host/WASM call
 * stack. Suspended C calls and coroutine stacks must be in linear memory.
 * Initial canonical flash is loaded at kanto_flash_ptr() before kanto_boot(). */
uint32_t kanto_abi_version(void);
int32_t kanto_boot(uint32_t seed, uint32_t has_save);
int32_t kanto_step(uint32_t buttons, uint32_t frames);
uint32_t kanto_frame(void);
uint32_t kanto_flash_ptr(void);
uint32_t kanto_flash_size(void);
/* Canonical, deterministic serialization of simulation state for hashing. */
uint32_t kanto_state_ptr(void);
uint32_t kanto_state_size(void);
/* Validate/rebind derived state after restoring an authenticated checkpoint. */
int32_t kanto_after_restore(void);
uint32_t kanto_framebuffer_ptr(void);
uint32_t kanto_framebuffer_size(void);
/* Rendering must not mutate canonical simulation state. */
int32_t kanto_render_frame(void);

/* Optional qualification exports: asset bytes excluded from mutable state.
 * They must remain equal to the pinned module initializer during gameplay. */
uint32_t kanto_immutable_ptr(void);
uint32_t kanto_immutable_size(void);

#endif
