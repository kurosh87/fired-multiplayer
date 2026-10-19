#ifndef KANTO_LIBC_STDIO_H
#define KANTO_LIBC_STDIO_H
#include <stddef.h>
#include <stdarg.h>
int puts(const char *text);
int printf(const char *format, ...);
int sprintf(char *destination, const char *format, ...);
int vsprintf(char *destination, const char *format, va_list arguments);
int snprintf(char *destination, size_t size, const char *format, ...);
int vsnprintf(char *destination, size_t size, const char *format, va_list arguments);
#endif
