// SPDX-License-Identifier: GPL-3.0-or-later
// Runs lm commands in worker.js, one at a time.
//
// Each command gets the project's files and gives back what it wrote, changed or deleted, so
// the page keeps the project (and lm's cell library) and the worker keeps nothing: Stop ends
// the worker and starts a fresh one, and only the command that was running is lost.

export class Session {
    constructor({onOutput, onPrompt, onState}) {
        this.onOutput = onOutput;
        this.onPrompt = onPrompt || (() => {});
        this.onState = onState || (() => {});
        this.worker = null;
        this.pending = new Map();
        this.nextId = 1;
        this.queue = Promise.resolve();
        this.busy = false;
        this.waiting = false;        // A simulator waits for a line
        this.current = null;
    }

    spawn() {
        this.worker?.terminate();
        for(const p of this.pending.values()) {
            p.reject(new Error("stopped"));
        }
        this.pending.clear();
        const worker = this.worker = new Worker(new URL("worker.js", import.meta.url));
        worker.onmessage = event => {
            const m = event.data;
            if(worker !== this.worker) {
                return;
            }
            if(m.type === "out") {
                this.onOutput(m.text, m.error);
            } else if(m.type === "prompt") {
                this.waiting = true;
                this.prompt = m.text.trim();
                this.onPrompt();
                this.onState();
            } else if(m.type === "reply") {
                const p = this.pending.get(m.id);
                this.pending.delete(m.id);
                p?.resolve(m);
            }
        };
        worker.onerror = event => {
            const why = event.message || "the worker failed";
            for(const p of this.pending.values()) {
                p.reject(new Error(why));
            }
            this.pending.clear();
        };
    }

    request(message, transfer) {
        if(!this.worker) {
            this.spawn();
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            this.worker.postMessage({...message, id}, transfer || []);
        });
    }

    // Run lm with argv on files ([{path, data}]) with the cell library (cells, the same, under
    // the technology folder); resolves with {code, error, changed, removed, cells, ms}.
    run(argv, files, cells = []) {
        const job = this.queue.then(() => this.runNow(argv, files, cells));
        this.queue = job.catch(() => {});
        return job;
    }

    async runNow(argv, files, cells) {
        this.busy = true;
        this.current = argv.join(" ");
        this.onState();
        try {
            return await this.request({type: "run", argv, files: files.map(f => ({path: f.path, data: f.data})),
                cells: cells.map(f => ({path: f.path, data: f.data}))});
        } finally {
            this.busy = false;
            this.waiting = false;
            this.current = null;
            this.onState();
        }
    }

    // A line for the simulator waiting at its prompt.
    line(text) {
        if(this.waiting) {
            this.waiting = false;
            this.worker.postMessage({type: "line", text});
            this.onState();
        }
    }

    // End the running command: a fresh worker takes over.
    stop() {
        if(!this.busy) {
            return false;
        }
        this.spawn();
        this.queue = Promise.resolve();
        this.busy = false;
        this.waiting = false;
        this.current = null;
        this.onState();
        return true;
    }
}
