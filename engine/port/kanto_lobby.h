#ifndef KANTO_LOBBY_H
#define KANTO_LOBBY_H
#include <stdint.h>
uint32_t kanto_lobby_save_abi_version(void);
int32_t kanto_lobby_save(void);
uint32_t KantoGameStartMenuAllowsSave(void);
#endif
