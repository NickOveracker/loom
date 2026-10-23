// SPDX-License-Identifier: GPL-3.0-or-later
// Loom's lm in a Web Worker.
//
// Each lm command is a process of its own, as in a terminal: the worker runs it in a fresh
// instance of the module (compiled once), with the project's files in /work, its working
// folder, and Loom's technology files in /usr/local/share/tech, where lm looks for them.
//
// Protocol (the web app, session.js):
//   {type: "run", id, argv, files: [{path, data}], cells: [{path, data}]}
//                                                    run lm with these arguments on these files
//   {type: "line", text}                             a line for a simulator waiting at its prompt
// The worker streams {type: "out", text, error} and {type: "prompt", text} (a simulator waits
// for a line, after printing text without a newline), and answers {type: "reply", id, code, changed: [{path, data}], removed: [path]}.
//
// The cells lm lays out go into the technology's cells folder, as lm's own cell library; the
// worker keeps them for the next commands, so that each cell is laid out once per session.

importScripts("loom.js");

const WORK = "/work";
const TECH = "/usr/local/share/tech";
let compiled = null;
let pendingLine = null;

function post(message, transfer) {
    self.postMessage(message, transfer || []);
}

function mkdirs(fs, path) {
    let dir = "";
    for(const part of path.split("/").filter(Boolean).slice(0, -1)) {
        dir += "/" + part;
        try {
            fs.mkdir(dir);
        } catch(e) {
            // Exists already
        }
    }
}

function walk(fs, root, prefix = "", out = new Map()) {
    let names;
    try {
        names = fs.readdir(root);
    } catch(e) {
        return out;
    }
    for(const name of names) {
        if(name === "." || name === "..") {
            continue;
        }
        const path = root + "/" + name, stat = fs.stat(path);
        if(fs.isDir(stat.mode)) {
            walk(fs, path, prefix + name + "/", out);
        } else {
            out.set(prefix + name, fs.readFile(path));
        }
    }
    return out;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

async function run(message) {
    if(!compiled) {
        compiled = await WebAssembly.compileStreaming(fetch(new URL("loom.wasm", location.href)));
    }
    let finish;
    const finished = new Promise(resolve => {
        finish = resolve;
    });
    const lm = await createLoom({
        instantiateWasm(imports, receive) {
            WebAssembly.instantiate(compiled, imports).then(instance => receive(instance, compiled));
            return {};
        },
        print: text => post({type: "out", text}),
        printErr: text => post({type: "out", text, error: true}),
        // The simulators' fgets(stdin) (web/stdin.c): wait for the page's next line.
        readLine: prompt => new Promise(resolve => {
            pendingLine = resolve;
            post({type: "prompt", text: prompt || ""});
        }),
        onExit: code => finish({code}),
        onAbort: reason => finish({code: -1, error: String(reason)}),
    });
    const fs = lm.FS;
    fs.mkdir(WORK);
    const before = new Map();
    for(const file of message.files) {
        mkdirs(fs, `${WORK}/${file.path}`);
        fs.writeFile(`${WORK}/${file.path}`, file.data);
        before.set(file.path, file.data);
    }
    const cellsBefore = new Map();
    for(const {path, data} of message.cells || []) {
        mkdirs(fs, `${TECH}/${path}`);
        fs.writeFile(`${TECH}/${path}`, data);
        cellsBefore.set(path, data);
    }
    fs.chdir(WORK);
    const t0 = performance.now();
    try {
        lm.callMain(message.argv);
    } catch(error) {
        if(!/ExitStatus|unwind/.test(String(error?.name || error))) {
            finish({code: -1, error: String(error?.message || error)});
        }
    }
    const result = await finished;
    pendingLine = null;
    // What lm wrote, changed or deleted in the project, and the cells it laid out.
    const after = walk(fs, WORK);
    const changed = [], removed = [];
    for(const [path, data] of after) {
        if(!before.has(path) || !same(before.get(path), data)) {
            changed.push({path, data});
        }
    }
    for(const path of before.keys()) {
        if(!after.has(path)) {
            removed.push(path);
        }
    }
    const cells = [];
    for(const [path, data] of walk(fs, TECH)) {
        if(/(^|\/)cells\/(?!README)/.test(path) && !(cellsBefore.has(path) && same(cellsBefore.get(path), data))) {
            cells.push({path, data});
        }
    }
    post({type: "reply", id: message.id, code: result.code, error: result.error || null, changed, removed, cells,
        ms: performance.now() - t0}, [...changed, ...cells].map(f => f.data.buffer));
}

self.onmessage = event => {
    const m = event.data;
    if(m.type === "run") {
        run(m).catch(error => post({type: "reply", id: m.id, code: -1, error: String(error?.message || error), changed: [], removed: [], cells: []}));
    } else if(m.type === "line") {
        const resolve = pendingLine;
        pendingLine = null;
        resolve?.(m.text);
    }
};
