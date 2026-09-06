/* Full-chip reset policy (see sys_reset.c for the measured reason). */
#pragma once

#include <stdbool.h>

/* Reset the whole chip via the RTC watchdog. Never returns. */
void sys_hard_reset(void) __attribute__((noreturn));

/* Call first thing in app_main(): returns true if this boot came from a
 * clean (full-chip) reset. Otherwise it forces one (does not return), except
 * when one was already forced, to rule out a reset loop. */
bool sys_reset_ensure_clean_boot(void);

/* Call once the running image has been confirmed valid (ota.c): if this boot
 * was a dirty one that had to be tolerated for the confirmation, reset clean now. */
void sys_reset_after_confirm(void);
