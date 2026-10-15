/**
 * @file	textvram.c
 * @brief	Decodes the PC-98 text VRAM (A0000h codes, A2000h attributes) into
 *			UTF-8 so agents can read the screen without OCR.
 *
 * Cell layout: ANK characters store the code in the low byte with a zero high
 * byte. Kanji occupy two cells; the low byte holds (JIS row - 20h) and the high
 * byte the JIS column. The right half repeats the code with bit 7 set in one
 * of the bytes (the BIOS sets it in the low byte, many games in the high byte)
 * or, in some programs, unchanged. A valid left half never has bit 7 set.
 */

#include "compiler.h"
#include "cpucore.h"
#include "codecnv/codecnv.h"

#define	TEXT_COLS	80
#define	TEXT_ROWS	25

static char s_utf8[TEXT_ROWS * (TEXT_COLS * 3 + 1) + 1];

static UINT jis_to_sjis(UINT j1, UINT j2, char *out) {
	UINT s1, s2;

	s1 = ((j1 + 1) >> 1) + ((j1 <= 0x5e) ? 0x70 : 0xb0);
	if (j1 & 1) {
		s2 = j2 + ((j2 >= 0x60) ? 0x20 : 0x1f);
	}
	else {
		s2 = j2 + 0x7e;
	}
	out[0] = (char)s1;
	out[1] = (char)s2;
	return 2;
}

static char ank_to_sjis(UINT8 c) {
	if (c == 0x5c) {
		return '\\';	/* shown as yen sign, used as path separator */
	}
	if ((c >= 0x20 && c < 0x7f) || (c >= 0xa1 && c <= 0xdf)) {
		return (char)c;
	}
	if (c == 0) {
		return ' ';
	}
	return '?';		/* semigraphics and control glyphs */
}

/**
 * @param[in] rows Number of rows to decode (1-25)
 * @param[in] honor_secret Hide cells whose attribute has the secret bit clear
 * @return UTF-8 text, one line per row, trailing spaces trimmed
 */
EMSCRIPTEN_KEEPALIVE
const char *np2w_text_vram_utf8(int rows, int honor_secret) {
	char sjis[TEXT_COLS * 2 + 1];
	char *dst = s_utf8;
	UINT remain = sizeof(s_utf8);
	int y, x;

	if (rows <= 0 || rows > TEXT_ROWS) {
		rows = TEXT_ROWS;
	}
	for (y = 0; y < rows; y++) {
		UINT n = 0;
		UINT w;

		for (x = 0; x < TEXT_COLS; x++) {
			UINT addr = 0xa0000 + (y * TEXT_COLS + x) * 2;
			UINT8 lo = mem[addr];
			UINT8 hi = mem[addr + 1];
			UINT8 attr = mem[addr + 0x2000];

			if (honor_secret && !(attr & 0x01)) {
				sjis[n++] = ' ';
				continue;
			}
			if (hi == 0) {
				sjis[n++] = ank_to_sjis(lo);
			}
			else if ((lo | hi) & 0x80) {
				/* right half of a kanji whose left half was emitted */
				continue;
			}
			else {
				UINT j1 = (lo & 0x7f) + 0x20;
				UINT j2 = hi & 0x7f;
				if (j1 >= 0x21 && j1 <= 0x7e && j2 >= 0x21 && j2 <= 0x7e) {
					n += jis_to_sjis(j1, j2, sjis + n);
				}
				else {
					sjis[n++] = '?';
				}
				if (x + 1 < TEXT_COLS) {
					UINT8 lo2 = mem[addr + 2];
					UINT8 hi2 = mem[addr + 3];
					if ((lo2 & 0x7f) == lo && (hi2 & 0x7f) == hi) {
						x++;
					}
				}
			}
		}
		while (n > 0 && sjis[n - 1] == ' ') {
			n--;
		}
		sjis[n] = '\0';
		w = codecnv_sjistoutf8(dst, remain - 1, sjis, (UINT)-1);
		if (w > 0) {
			w--;	/* drop the terminator */
		}
		dst += w;
		remain -= w;
		*dst++ = '\n';
		remain--;
	}
	*dst = '\0';
	return s_utf8;
}
