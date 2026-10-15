/**
 * @file	fontmng.c
 * @brief	No host fonts: the PC-98 font always comes from font.bmp/font.rom.
 */

#include "compiler.h"
#include "fontmng.h"

BRESULT fontmng_init(void) { return SUCCESS; }
void fontmng_setdeffontname(const char *name) { (void)name; }
void *fontmng_create(int size, UINT type, const char *fontface) {
	(void)size; (void)type; (void)fontface;
	return NULL;
}
void fontmng_destroy(void *hdl) { (void)hdl; }
BRESULT fontmng_getsize(void *hdl, const char *string, POINT_T *pt) {
	(void)hdl; (void)string; (void)pt;
	return FAILURE;
}
BRESULT fontmng_getdrawsize(void *hdl, const char *string, POINT_T *pt) {
	(void)hdl; (void)string; (void)pt;
	return FAILURE;
}
FNTDAT fontmng_get(void *hdl, const char *string) {
	(void)hdl; (void)string;
	return NULL;
}
