/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Included (build.sh: -include) before lm's simulator, sim.cpp: its fgets(stdin) reads a line
 * from the page's console (web/stdin.c), waiting for it as a terminal would. */
#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
char *loom_web_fgets(char *buf, int size, FILE *file);
#ifdef __cplusplus
}
#endif
#define fgets loom_web_fgets
