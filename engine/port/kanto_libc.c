#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#include "libc/string.h"
#include "libc/stdio.h"

extern void KantoPlatformLog(const char *text);

void *memcpy(void *destination, const void *source, size_t size)
{
    volatile unsigned char *to = destination;
    const volatile unsigned char *from = source;
    while (size--) *to++ = *from++;
    return destination;
}

void *memmove(void *destination, const void *source, size_t size)
{
    unsigned char *to = destination;
    const unsigned char *from = source;
    if ((uintptr_t)to < (uintptr_t)from) return memcpy(destination, source, size);
    while (size) { size--; to[size] = from[size]; }
    return destination;
}

void *memset(void *destination, int value, size_t size)
{
    volatile unsigned char *to = destination;
    while (size--) *to++ = (unsigned char)value;
    return destination;
}

int memcmp(const void *left, const void *right, size_t size)
{
    const unsigned char *a = left, *b = right;
    for (size_t i = 0; i < size; i++) if (a[i] != b[i]) return (int)a[i] - b[i];
    return 0;
}

size_t strlen(const char *text) { const char *end = text; while (*end) end++; return (size_t)(end - text); }
char *strcpy(char *destination, const char *source) { char *to = destination; while ((*to++ = *source++)) {} return destination; }
char *strncpy(char *destination, const char *source, size_t size) { size_t i = 0; for (; i < size && source[i]; i++) destination[i] = source[i]; for (; i < size; i++) destination[i] = 0; return destination; }
char *strcat(char *destination, const char *source) { strcpy(destination + strlen(destination), source); return destination; }
int strcmp(const char *left, const char *right) { while (*left && *left == *right) { left++; right++; } return (unsigned char)*left - (unsigned char)*right; }
int strncmp(const char *left, const char *right, size_t size) { for (size_t i = 0; i < size; i++) { int difference = (unsigned char)left[i] - (unsigned char)right[i]; if (difference || !left[i]) return difference; } return 0; }
char *strchr(const char *text, int character) { do { if ((unsigned char)*text == (unsigned char)character) return (char *)text; } while (*text++); return NULL; }

struct Writer { char *destination; size_t capacity; size_t count; };
static void Character(struct Writer *writer, char value)
{
    if (writer->capacity && writer->count < writer->capacity - 1) writer->destination[writer->count] = value;
    writer->count++;
}

/* Diagnostics use integer/string formats. Unsupported formats report an I/O
 * error; they never become platform imports or successful placeholder output. */
int vsnprintf(char *destination, size_t size, const char *format, va_list arguments)
{
    struct Writer writer = {destination, size, 0};
    for (const char *p = format; *p; p++)
    {
        if (*p != '%') { Character(&writer, *p); continue; }
        p++;
        if (*p == '%') { Character(&writer, '%'); continue; }
        char padding = ' ';
        if (*p == '0') { padding = '0'; p++; }
        unsigned width = 0;
        while (*p >= '0' && *p <= '9') { width = width * 10 + (unsigned)(*p++ - '0'); if (width > 1024) return -1; }
        unsigned length = 0;
        if (*p == 'z') { length = sizeof(size_t) == 8 ? 2 : 1; p++; }
        else while (*p == 'l') { length++; p++; }
        if (*p == 's')
        {
            const char *text = va_arg(arguments, const char *);
            if (!text) text = "(null)";
            while (*text) Character(&writer, *text++);
        }
        else if (*p == 'c') Character(&writer, (char)va_arg(arguments, int));
        else if (*p == 'd' || *p == 'i' || *p == 'u' || *p == 'x' || *p == 'X' || *p == 'p')
        {
            unsigned base = (*p == 'x' || *p == 'X' || *p == 'p') ? 16 : 10;
            uint64_t value;
            int negative = 0;
            if (*p == 'p') value = (uintptr_t)va_arg(arguments, void *);
            else if (*p == 'd' || *p == 'i')
            {
                int64_t number = length >= 2 ? va_arg(arguments, long long) : length ? va_arg(arguments, long) : va_arg(arguments, int);
                negative = number < 0;
                value = negative ? 0 - (uint64_t)number : (uint64_t)number;
            }
            else value = length >= 2 ? va_arg(arguments, unsigned long long) : length ? va_arg(arguments, unsigned long) : va_arg(arguments, unsigned int);
            char digits[64]; unsigned count = 0;
            const char *alphabet = *p == 'X' ? "0123456789ABCDEF" : "0123456789abcdef";
            do { digits[count++] = alphabet[value % base]; value /= base; } while (value);
            if (negative && padding == '0') Character(&writer, '-');
            for (unsigned n = count + (unsigned)negative; n < width; n++) Character(&writer, padding);
            if (negative && padding != '0') Character(&writer, '-');
            while (count) Character(&writer, digits[--count]);
        }
        else return -1;
    }
    if (size) destination[writer.count < size ? writer.count : size - 1] = 0;
    return writer.count <= INT32_MAX ? (int)writer.count : -1;
}

int snprintf(char *destination, size_t size, const char *format, ...) { va_list arguments; va_start(arguments, format); int result = vsnprintf(destination, size, format, arguments); va_end(arguments); return result; }
int vsprintf(char *destination, const char *format, va_list arguments) { return vsnprintf(destination, SIZE_MAX, format, arguments); }
int sprintf(char *destination, const char *format, ...) { va_list arguments; va_start(arguments, format); int result = vsprintf(destination, format, arguments); va_end(arguments); return result; }
int printf(const char *format, ...) { char text[1024]; va_list arguments; va_start(arguments, format); int result = vsnprintf(text, sizeof(text), format, arguments); va_end(arguments); if (result < 0 || (unsigned)result >= sizeof(text)) return -1; KantoPlatformLog(text); return result; }
int puts(const char *text) { if (strlen(text) > INT32_MAX - 1) return -1; KantoPlatformLog(text); return (int)strlen(text) + 1; }
