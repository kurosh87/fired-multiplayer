#ifndef KANTO_SCHEDULER_H
#define KANTO_SCHEDULER_H
#include <stdint.h>
void KantoSchedulerInit(void);
int32_t KantoSchedulerStep(void);
void KantoYieldFrame(void);
void KantoSchedulerRequestReset(void);
int32_t KantoSchedulerValidate(void);
#endif
