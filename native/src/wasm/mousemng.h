
enum {
	uPD8255A_LEFTBIT	= 0x80,
	uPD8255A_RIGHTBIT	= 0x20
};

#ifdef __cplusplus
extern "C" {
#endif

void mousemng_initialize(void);
UINT8 mousemng_getstat(SINT16 *x, SINT16 *y, int clear);
void mousemng_move(int dx, int dy);
void mousemng_setbuttons(int left, int right);

#ifdef __cplusplus
}
#endif

