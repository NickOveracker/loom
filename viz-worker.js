// SPDX-License-Identifier: GPL-3.0-or-later
// Graphviz (Viz.js, vendor/viz/) in a worker of its own: {id, dot} in, {id, svg} or {id, error} out.
// lm show writes Graphviz files; the native lm draws them with Graphviz, and this does the same
// for the page.  Graphviz is a separate program here, as it is to the native lm.
importScripts("vendor/viz/viz-global.js");

const ready = Viz.instance();

self.onmessage = async event => {
    const {id, dot} = event.data;
    try {
        const viz = await ready;
        self.postMessage({id, svg: viz.renderString(dot, {format: "svg"})});
    } catch(error) {
        self.postMessage({id, error: String(error?.message || error)});
    }
};
