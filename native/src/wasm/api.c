/**
 * @file	api.c
 * @brief	pc98-web host API. Replaces the SDL main loop: the host drives the
 *			machine explicitly, one frame at a time, which makes the same
 *			binary usable from a browser render loop and from a headless,
 *			step-driven agent session in Node.
 */

#include "compiler.h"
#include "np2.h"
#include "np2w.h"
#include "dosio.h"
#include "commng.h"
#include "fontmng.h"
#include "mousemng.h"
#include "scrnmng.h"
#include "soundmng.h"
#include "sysmng.h"
#include "taskmng.h"
#include "ini.h"
#include "pccore.h"
#include "cpucore.h"
#include "statsave.h"
#include "iocore.h"
#include "scrndraw.h"
#include "s98.h"
#include "timing.h"
#include "keystat.h"
#include "sound.h"

NP2OSCFG	np2oscfg = { .enable_menu = FALSE };

void msgbox(const char *title, const char *msg) {
	fprintf(stderr, "%s: %s\n", title, msg);
}

static UINT64 s_epoch_ms;
static UINT64 s_elapsed_clocks;
static UINT32 s_frames;
static BOOL s_ready;

#define	AUDIO_MAXFRAMES	16384
static SINT16 s_audio[AUDIO_MAXFRAMES * 2];

static UINT32 nowclock(void) {
	return CPU_CLOCK + CPU_BASECLOCK - CPU_REMCLOCK;
}

UINT64 np2w_epoch_ms(void) {
	return s_epoch_ms;
}

UINT64 np2w_elapsed_ms(void) {
	if (pccore.realclock == 0) {
		return 0;
	}
	return s_elapsed_clocks * 1000 / pccore.realclock;
}

UINT32 np2w_gettick(void) {
	return (UINT32)np2w_elapsed_ms();
}

int main(int argc, char *argv[]) {
	(void)argc;
	(void)argv;
	return 0;
}

/**
 * Boots the machine. Config values are pulled from Module.getConfig (ini.c).
 * @param[in] epoch_ms Emulated wall clock at power-on, in local-time ms
 */
EMSCRIPTEN_KEEPALIVE
int np2w_init(double epoch_ms) {
	if (s_ready) {
		return SUCCESS;
	}
	s_epoch_ms = (UINT64)epoch_ms;
	initload();
	TRACEINIT();
	fontmng_init();
	keystat_initialize();
	scrnmng_initialize();
	if (scrnmng_create(FULLSCREEN_WIDTH, FULLSCREEN_HEIGHT) != SUCCESS) {
		return FAILURE;
	}
	mousemng_initialize();
	soundmng_initialize();
	commng_initialize();
	sysmng_initialize();
	taskmng_initialize();
	pccore_init();
	S98_init();
	scrndraw_redraw();
	pccore_reset();
	timing_reset();
	s_ready = TRUE;
	return SUCCESS;
}

EMSCRIPTEN_KEEPALIVE
void np2w_reset(void) {
	pccore_cfgupdate();
	pccore_reset();
	task_avail = TRUE;
}

/**
 * Runs exactly one video frame.
 * @return 1 while the machine is powered, 0 after it shut itself down
 */
EMSCRIPTEN_KEEPALIVE
int np2w_run_frame(int draw) {
	UINT32 before;

	if (!s_ready || !task_avail) {
		return 0;
	}
	before = nowclock();
	pccore_exec(draw ? TRUE : FALSE);
	s_elapsed_clocks += (UINT32)(nowclock() - before);
	s_frames++;
	timing_getcount();	/* drives the FDD motor timer */
	return task_avail ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
UINT32 np2w_frames(void) {
	return s_frames;
}

EMSCRIPTEN_KEEPALIVE
double np2w_elapsed_ms_f(void) {
	return (double)np2w_elapsed_ms();
}

EMSCRIPTEN_KEEPALIVE
UINT32 np2w_realclock(void) {
	return pccore.realclock;
}

// ---- screen

EMSCRIPTEN_KEEPALIVE int np2w_get_screen_width(void) { return np2w_screen_width(); }
EMSCRIPTEN_KEEPALIVE int np2w_get_screen_height(void) { return np2w_screen_height(); }
EMSCRIPTEN_KEEPALIVE UINT32 np2w_get_screen_version(void) { return np2w_screen_version(); }
EMSCRIPTEN_KEEPALIVE const UINT8 *np2w_get_screen_rgba(void) { return np2w_screen_rgba(); }

// ---- audio

EMSCRIPTEN_KEEPALIVE
UINT32 np2w_audio_rate(void) {
	return soundcfg.rate;
}

EMSCRIPTEN_KEEPALIVE
const SINT16 *np2w_audio_buffer(void) {
	return s_audio;
}

/** @return stereo frames now available in np2w_audio_buffer() */
EMSCRIPTEN_KEEPALIVE
UINT np2w_audio_drain(void) {
	return sound_drain(s_audio, AUDIO_MAXFRAMES);
}

// ---- input

/** Sends a PC-98 keyboard scan code (0x00-0x7f). */
EMSCRIPTEN_KEEPALIVE
void np2w_key(int code, int down) {
	keystat_senddata((REG8)((code & 0x7f) | (down ? 0 : 0x80)));
}

EMSCRIPTEN_KEEPALIVE
void np2w_key_release_all(void) {
	keystat_allrelease();
}

EMSCRIPTEN_KEEPALIVE
void np2w_mouse_move(int dx, int dy) {
	mousemng_move(dx, dy);
}

EMSCRIPTEN_KEEPALIVE
void np2w_mouse_buttons(int left, int right) {
	mousemng_setbuttons(left, right);
}

// ---- memory

EMSCRIPTEN_KEEPALIVE
UINT8 *np2w_mem_base(void) {
	return mem;
}

// ---- save states

EMSCRIPTEN_KEEPALIVE
int np2w_state_save(const char *path) {
	return statsave_save(path);
}

EMSCRIPTEN_KEEPALIVE
int np2w_state_load(const char *path) {
	int ret = statsave_load(path);
	task_avail = TRUE;
	return ret;
}
