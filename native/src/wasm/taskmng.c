#include "compiler.h"
#include "taskmng.h"

	BOOL	task_avail;

void taskmng_initialize(void) {
	task_avail = TRUE;
}

void taskmng_exit(void) {
	task_avail = FALSE;
#ifdef __EMSCRIPTEN__
	EM_ASM({ if (Module.onExit) Module.onExit(); });
#endif
}

BOOL taskmng_sleep(UINT32 tick) {
	(void)tick;
	return task_avail;
}
