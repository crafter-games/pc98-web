#include "compiler.h"
#include "mousemng.h"

typedef struct {
	SINT16	x;
	SINT16	y;
	UINT8	btn;
} MOUSEMNG;

static	MOUSEMNG	mousemng;

void mousemng_initialize(void) {
	ZeroMemory(&mousemng, sizeof(mousemng));
	mousemng.btn = uPD8255A_LEFTBIT | uPD8255A_RIGHTBIT;
}

UINT8 mousemng_getstat(SINT16 *x, SINT16 *y, int clear) {
	*x = mousemng.x;
	*y = mousemng.y;
	if (clear) {
		mousemng.x = 0;
		mousemng.y = 0;
	}
	return mousemng.btn;
}

void mousemng_move(int dx, int dy) {
	mousemng.x += (SINT16)dx;
	mousemng.y += (SINT16)dy;
}

/* PC-98 mouse buttons are active low. */
void mousemng_setbuttons(int left, int right) {
	mousemng.btn = (left ? 0 : uPD8255A_LEFTBIT) | (right ? 0 : uPD8255A_RIGHTBIT);
}
