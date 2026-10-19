#include <assert.h>
#include <stdint.h>
#include "../engine/port/libc/string.h"
#include "../engine/port/libc/stdio.h"

static char sLog[1024];
void KantoPlatformLog(const char *text) { strncpy(sLog, text, sizeof(sLog)); sLog[sizeof(sLog) - 1] = 0; }

int main(void)
{
    char memory[16];
    memset(memory, 0x7f, sizeof(memory));
    assert((unsigned char)memory[15] == 0x7f);
    memcpy(memory, "abcdef", 7);
    memmove(memory + 1, memory, 6);
    assert(memcmp(memory, "aabcdef", 7) == 0);
    memmove(memory, memory + 1, 6);
    assert(memcmp(memory, "abcdef", 6) == 0);
    strcpy(memory, "one"); strcat(memory, "two");
    assert(strcmp(memory, "onetwo") == 0);
    assert(strncmp(memory, "one", 3) == 0);
    assert(strcmp("a", "b") < 0);
    assert(strchr(memory, 't') == memory + 3);
    assert(strchr(memory, 0) == memory + 6);
    strncpy(memory, "x", 4);
    assert(memory[0] == 'x' && memory[1] == 0 && memory[3] == 0);
    char formatted[128];
    assert(snprintf(formatted, sizeof(formatted), "%s %d %08x %llu %%", "test", INT32_MIN, 0x123u, 18446744073709551615ull) == 48);
    assert(strcmp(formatted, "test -2147483648 00000123 18446744073709551615 %") == 0);
    assert(snprintf(formatted, 4, "%s", "abcdef") == 6);
    assert(strcmp(formatted, "abc") == 0);
    assert(snprintf(NULL, 0, "%u", 12345u) == 5);
    assert(printf("Boot %u", 17u) == 7);
    assert(strcmp(sLog, "Boot 17") == 0);
    return 0;
}
