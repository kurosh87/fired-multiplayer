#ifndef KANTO_EXCHANGE_H
#define KANTO_EXCHANGE_H
#include <stdint.h>

/* Trusted server exchange ABI. Open only on a fresh boot containing a
 * canonical cartridge save. Packets stay opaque to the host and are copied
 * only between authenticated, server-owned cores of these two game versions.
 * No exchange output becomes authoritative before the two-save transaction. */
#define KANTO_EXCHANGE_ABI 1u
#define KANTO_EXCHANGE_CLOSED 0u
#define KANTO_EXCHANGE_OPEN 1u
#define KANTO_EXCHANGE_RUNNING 2u
#define KANTO_EXCHANGE_DONE 3u
#define KANTO_EXCHANGE_FAILED 4u

int32_t kanto_exchange_open(void);
uint32_t kanto_exchange_abi_version(void);
uint32_t kanto_exchange_phase(void);
uint32_t kanto_exchange_packet_ptr(void);
uint32_t kanto_exchange_packet_size(void);
uint32_t kanto_exchange_receive_ptr(void);
uint32_t kanto_exchange_mon_ptr(uint32_t slot);
uint32_t kanto_exchange_mon_size(void);
uint32_t kanto_exchange_mon_text_ptr(uint32_t slot, uint32_t kind);
uint32_t kanto_exchange_mon_text_size(void);
uint32_t kanto_exchange_party_count(void);
/* Keys 0..18: personality, OT, species, level, HP, max HP, held item,
 * friendship/egg cycles, egg, checksum, bad egg, four moves, four PP values. */
uint32_t kanto_exchange_mon_field(uint32_t slot, uint32_t key);
int32_t kanto_exchange_check(uint32_t slot, uint32_t peer_slot);
int32_t kanto_exchange_start(uint32_t slot, uint32_t peer_slot);

/* Boundaries called from the reviewed original trade source. Mechanics,
 * animation, mail, ribbon flags, evolution and move learning remain there. */
uint32_t KantoExchangeIsTrade(void);
void KantoExchangeFinishTrade(void);
int32_t KantoGameCheckTrade(uint32_t slot, uint32_t peer_slot);
int32_t KantoGameMergeGiftRibbons(const uint8_t *ribbons, uint32_t size);
#endif
