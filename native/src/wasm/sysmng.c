/**
 *	@file	sysmng.c
 *	@brief	Implementation of the system
 */

#include "compiler.h"
#include "sysmng.h"
#include "ini.h"

/**
 * Initialize
 */
void sysmng_initialize(void)
{
}

/**
 * Deinitialize
 */
void sysmng_deinitialize(void)
{
}

/**
 * Notifies flags
 * @param[in] update update flags
 */
void sysmng_update(UINT update)
{
	if (update & (SYS_UPDATECFG | SYS_UPDATEOSCFG))
	{
		initsave();
	}
}

/**
 * Notifies CPU Reset
 */
void sysmng_cpureset(void)
{
}

static UINT32 s_disk_activity;

void sysmng_fddaccess(UINT8 drv)
{
	(void)drv;
	s_disk_activity++;
}

void sysmng_hddaccess(UINT8 drv)
{
	(void)drv;
	s_disk_activity++;
}

/**
 * Disk accesses (sectors read or written) since power-on. Agents use it to
 * tell a quiet loading screen from one that is really waiting for input.
 */
EMSCRIPTEN_KEEPALIVE
UINT32 np2w_disk_activity(void)
{
	return s_disk_activity;
}
