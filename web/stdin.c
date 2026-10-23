/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Console input for lm's simulators in the web build: fgets on stdin waits, through Asyncify,
 * for Module.readLine() (the worker's next line from the page; null at the end of input). */
#include <emscripten.h>
#include <stdio.h>
#include <string.h>

EM_ASYNC_JS(int, loom_web_read_line, (char *buf, int size), {
    // The prompt is still in the terminal's line buffer (it has no newline): give it to the
    // page, which shows it at the input.
    const tty = FS.getStream(1)?.tty;
    let prompt = "";
    if (tty && tty.output && tty.output.length) {
        prompt = UTF8ArrayToString(tty.output);
        tty.output = [];
    }
    const line = await Module.readLine(prompt);
    if (line === null || line === undefined) {
        return 0;
    }
    stringToUTF8(line + "\n", buf, size);
    return 1;
});

char *loom_web_fgets(char *buf, int size, FILE *file) {
    if (file != stdin) {
        return fgets(buf, size, file);
    }
    /* The prompt, written but not yet flushed to the terminal, before waiting. */
    fflush(stdout);
    return loom_web_read_line(buf, size) ? buf : NULL;
}
