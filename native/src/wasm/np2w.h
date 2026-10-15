/**
 * @file	np2w.h
 * @brief	pc98-web host interface: the functions the TypeScript core calls.
 */

#pragma once

#ifdef __cplusplus
extern "C" {
#endif

UINT64 np2w_epoch_ms(void);
UINT64 np2w_elapsed_ms(void);

int np2w_screen_width(void);
int np2w_screen_height(void);
UINT32 np2w_screen_version(void);
const UINT8 *np2w_screen_rgba(void);

#ifdef __cplusplus
}
#endif
