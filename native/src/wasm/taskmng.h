
#ifdef __cplusplus
extern "C" {
#endif

extern	BOOL	task_avail;

void taskmng_initialize(void);
void taskmng_exit(void);
#define	taskmng_rol()
#define	taskmng_isavail()		(task_avail)
BOOL taskmng_sleep(UINT32 tick);

#ifdef __cplusplus
}
#endif

