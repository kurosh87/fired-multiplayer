#include "../engine/port/kanto_entropy.h"
#include <assert.h>
#include <stdint.h>

int main(void)
{
    struct KantoEntropyCounter a, b;
    KantoEntropyInit(&a, 12345);
    KantoEntropyInit(&b, 12345);
    assert(a.origin == b.origin);
    KantoEntropyStart(&a);
    KantoEntropyAdvance(&a, 1);
    assert(a.value == (uint16_t)(b.origin + 18752u));
    assert(a.value != b.value);
    KantoEntropyAdvance(&b, 1);
    assert(a.value == b.value);
    /* Fresh-checkpoint replay and batched/single-frame stepping agree. */
    b = a;
    KantoEntropyAdvance(&a, 60000);
    for (uint32_t i = 0; i < 60000; i++) KantoEntropyAdvance(&b, 1);
    assert(a.value == b.value);
    uint16_t before = a.value;
    KantoEntropyAdvance(&a, 0);
    assert(a.value == before);
    /* Upper seed bits must survive the original game's later u16 seeding. */
    KantoEntropyInit(&a, 1);
    KantoEntropyInit(&b, 65537);
    assert(a.origin != b.origin);
    KantoEntropyAdvance(&a, UINT32_MAX);
    assert(a.value == (uint16_t)(a.origin - 18752u));
    KantoEntropyStart(&a);
    assert(a.value == a.origin);
    return 0;
}
