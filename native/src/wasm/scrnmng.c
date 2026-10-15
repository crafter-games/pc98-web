/**
 * @file	scrnmng.c
 * @brief	Headless screen manager: NP2 draws into an in-memory 32bpp surface
 *			that the host reads after each frame.
 */

#include "compiler.h"
#include "scrnmng.h"
#include "np2w.h"

#define	SURF_WIDTH	640
#define	SURF_HEIGHT	480

static UINT32 s_surface[SURF_WIDTH * SURF_HEIGHT];
static UINT8 s_rgba[SURF_WIDTH * SURF_HEIGHT * 4];
static SCRNSURF s_scrnsurf;
static int s_width = 640;
static int s_height = 400;
static UINT32 s_version;

void scrnmng_initialize(void) {
	s_width = 640;
	s_height = 400;
}

BRESULT scrnmng_create(int width, int height) {
	(void)width;
	(void)height;
	memset(s_surface, 0, sizeof(s_surface));
	return SUCCESS;
}

void scrnmng_destroy(void) {
}

RGB16 scrnmng_makepal16(RGB32 pal32) {
	RGB16 ret;

	ret = (pal32.p.r & 0xf8) << 8;
	ret += (pal32.p.g & 0xfc) << 3;
	ret += pal32.p.b >> 3;
	return ret;
}

void scrnmng_setwidth(int posx, int width) {
	(void)posx;
	s_width = min(width, SURF_WIDTH);
}

void scrnmng_setheight(int posy, int height) {
	(void)posy;
	s_height = min(height, SURF_HEIGHT);
}

const SCRNSURF *scrnmng_surflock(void) {
	s_scrnsurf.ptr = (UINT8 *)s_surface;
	s_scrnsurf.xalign = 4;
	s_scrnsurf.yalign = SURF_WIDTH * 4;
	s_scrnsurf.width = s_width;
	s_scrnsurf.height = s_height;
	s_scrnsurf.bpp = 32;
	s_scrnsurf.extend = 0;
	return &s_scrnsurf;
}

void scrnmng_surfunlock(const SCRNSURF *surf) {
	(void)surf;
	s_version++;
}

// ---- host API

int np2w_screen_width(void) { return s_width; }
int np2w_screen_height(void) { return s_height; }
UINT32 np2w_screen_version(void) { return s_version; }

/* Converts the visible area to tightly packed RGBA and returns a pointer to it. */
const UINT8 *np2w_screen_rgba(void) {
	int x, y;
	UINT8 *q = s_rgba;

	for (y = 0; y < s_height; y++) {
		const UINT32 *p = s_surface + y * SURF_WIDTH;
		for (x = 0; x < s_width; x++) {
			UINT32 c = p[x];
			q[0] = (UINT8)(c >> 16);
			q[1] = (UINT8)(c >> 8);
			q[2] = (UINT8)c;
			q[3] = 0xff;
			q += 4;
		}
	}
	return s_rgba;
}
