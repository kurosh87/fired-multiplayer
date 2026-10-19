#ifndef KANTO_BATTLE_H
#define KANTO_BATTLE_H
#include <stdint.h>

/* Experimental trusted-server link battle transport. No client supplies
 * parties or packets; gameplay/controller commands stay in original C. */
uint32_t kanto_battle_abi_version(void);
int32_t kanto_battle_open(uint32_t player);
uint32_t kanto_battle_phase(void);
uint32_t kanto_battle_hello_ptr(void);
uint32_t kanto_battle_peer_ptr(void);
uint32_t kanto_battle_hello_size(void);
int32_t kanto_battle_start(void);
uint32_t kanto_battle_out_ptr(void);
uint32_t kanto_battle_in_ptr(void);
uint32_t kanto_battle_block_size(void);
int32_t kanto_battle_ack(uint32_t serial);
int32_t kanto_battle_deliver(void);
uint32_t kanto_battle_read(uint32_t key, uint32_t battler);
/* Bit 8: original turn-selection phase; bits 0..1: its required players.
 * Bits 16..17: this console's original UI request (action/move/replacement). */
uint32_t kanto_battle_decision(void);

uint32_t KantoBattleIsActive(void);
uint32_t KantoBattlePlayer(void);
uint32_t KantoBattleSend(const void *source, uint32_t size);
uint32_t KantoBattleSendFinished(void);
uint32_t KantoBattleReceived(void);
void KantoBattleResetReceived(uint32_t mask);
void KantoBattleFinish(void);
uint32_t KantoGameBattleTurnRequest(void);
uint32_t KantoGameBattlePlayerRequest(uint32_t player);
#endif
