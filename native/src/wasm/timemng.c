/**
 * @file	timemng.c
 * @brief	Emulated wall clock: host-provided epoch plus emulated time elapsed,
 *			so runs are reproducible when the epoch is fixed.
 */

#include "compiler.h"
#include <time.h>
#include "timemng.h"
#include "np2w.h"

BRESULT timemng_gettime(_SYSTIME *systime) {
	time_t t;
	struct tm *now;
	UINT64 ms = np2w_epoch_ms() + np2w_elapsed_ms();

	t = (time_t)(ms / 1000);
	now = gmtime(&t);
	if (now == NULL) {
		return FAILURE;
	}
	systime->year = now->tm_year + 1900;
	systime->month = now->tm_mon + 1;
	systime->week = now->tm_wday;
	systime->day = now->tm_mday;
	systime->hour = now->tm_hour;
	systime->minute = now->tm_min;
	systime->second = now->tm_sec;
	systime->milli = (UINT16)(ms % 1000);
	return SUCCESS;
}
