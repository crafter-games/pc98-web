/**
 * @file	soundmng.c
 * @brief	Headless sound manager: the host drains generated PCM after each
 *			frame with np2w_audio_drain().
 */

#include "compiler.h"
#include "soundmng.h"
#include "sound.h"
#if defined(VERMOUTH_LIB)
#include "commng.h"
#include "cmver.h"
#endif

static BOOL s_opened;

UINT soundmng_create(UINT rate, UINT ms) {
	if (s_opened) {
		return 0;
	}
#if defined(VERMOUTH_LIB)
	cmvermouth_load(rate);
#endif
	s_opened = TRUE;
	return rate * ms / 1000;
}

void soundmng_destroy(void) {
	s_opened = FALSE;
}

void soundmng_play(void) {
}

void soundmng_stop(void) {
}

void soundmng_initialize(void) {
}

void soundmng_deinitialize(void) {
#if defined(VERMOUTH_LIB)
	cmvermouth_unload();
#endif
}
