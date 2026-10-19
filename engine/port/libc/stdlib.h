#ifndef KANTO_LIBC_STDLIB_H
#define KANTO_LIBC_STDLIB_H
#include <stddef.h>
#ifndef abs
int abs(int value);
#endif
_Noreturn void abort(void);
_Noreturn void exit(int status);
void *malloc(size_t size);
void *calloc(size_t count, size_t size);
void free(void *pointer);
#endif
