// SPDX-License-Identifier: GPL-3.0-or-later
// The Waves window: the value change dumps (.vcd) lm sim writes, drawn as digital waveforms.
// lm sim records each simulation as <process>.vcd (with a GTKWave save file, .gtkw); this
// draws its one-bit signals, one row each (X and Z as a band), with the time axis in the
// file's units.  Choose the signals in the list; drag to pan, wheel to zoom in time.

import {FloatingWindow} from "./floating-window.js";

const decoder = new TextDecoder();

export function readVcd(text) {
    const signals = new Map();          // id -> {name, width, changes: [[time, value]]}
    let time = 0, end = 0, timescale = "", inDefs = true;
    const tokens = text.split(/\s+/);
    for(let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if(!t) {
            continue;
        }
        if(t === "$var") {
            const [, width, id, ...rest] = tokens.slice(i + 1, tokens.indexOf("$end", i));
            const name = rest.join(" ");
            if(!signals.has(id)) {
                signals.set(id, {name, width: Number(width) || 1, changes: []});
            }
            i = tokens.indexOf("$end", i);
        } else if(t === "$timescale") {
            timescale = tokens.slice(i + 1, tokens.indexOf("$end", i)).join("");
            i = tokens.indexOf("$end", i);
        } else if(t === "$enddefinitions") {
            inDefs = false;
            i = tokens.indexOf("$end", i);
        } else if(t.startsWith("$")) {
            if(t !== "$dumpvars" && t !== "$end") {
                const close = tokens.indexOf("$end", i);
                i = close < 0 ? tokens.length : close;
            }
        } else if(!inDefs || t[0] === "#") {
            if(t[0] === "#") {
                time = Number(t.slice(1));
                end = Math.max(end, time);
            } else if(/^[01xzXZ]/.test(t) && t.length > 1) {
                signals.get(t.slice(1))?.changes.push([time, t[0].toLowerCase()]);
            } else if(/^[bBrR]/.test(t)) {
                signals.get(tokens[i + 1])?.changes.push([time, t.slice(1)]);
                i++;
            }
        }
    }
    return {signals: [...signals.values()], end, timescale};
}

export class WavesWindow {
    // host: {desktop, files(): [{path, data}]}
    constructor(host) {
        this.host = host;
        this.fw = null;
        this.path = null;
        this.shown = new Set();
        this.span = null;               // [t0, t1] on screen
    }

    isOpen() {
        return Boolean(this.fw);
    }

    open(path) {
        if(!this.fw) {
            const d = this.host.desktop;
            this.fw = new FloatingWindow(d, {title: "Waves", x: 36, y: Math.max(12, d.clientHeight - 380),
                width: Math.min(700, d.clientWidth - 72), height: Math.min(360, d.clientHeight - 24), onClose: () => this.close()});
            this.fw.body.innerHTML = `<div class="lay-body"><div class="lay-bar"><select aria-label="Waveform file"></select>
                <button type="button" data-act="fit">Fit</button><button type="button" data-act="all">All</button>
                <button type="button" data-act="none">None</button><span class="lay-info"></span></div>
                <div class="lay-main"><canvas aria-label="Waveforms"></canvas><ul class="lay-layers" aria-label="Signals"></ul></div></div>`;
            this.select = this.fw.body.querySelector("select");
            this.canvas = this.fw.body.querySelector("canvas");
            this.list = this.fw.body.querySelector(".lay-layers");
            this.info = this.fw.body.querySelector(".lay-info");
            this.select.addEventListener("change", () => this.load(this.select.value, true));
            this.fw.body.querySelector(".lay-bar").addEventListener("click", e => {
                const act = e.target.closest("button")?.dataset.act;
                if(act === "fit") {
                    this.span = null;
                    this.draw();
                } else if(act === "all" || act === "none") {
                    this.shown = act === "all" ? new Set(this.vcd?.signals.map(s => s.name)) : new Set();
                    this.renderList();
                    this.draw();
                }
            });
            this.listen();
            new ResizeObserver(() => this.draw()).observe(this.canvas);
        } else {
            this.fw.raise();
        }
        this.refresh(path);
    }

    close() {
        this.fw?.remove();
        this.fw = null;
    }

    refresh(path) {
        if(!this.fw) {
            return;
        }
        const files = this.host.files().filter(f => /\.vcd$/i.test(f.path));
        this.select.textContent = "";
        for(const f of files) {
            this.select.add(new Option(f.path, f.path));
        }
        if(!files.length) {
            this.select.add(new Option("(no .vcd files: lm sim writes one when you quit it)", ""));
            this.vcd = null;
            this.draw();
            return;
        }
        const wanted = path && files.some(f => f.path === path) ? path : files.some(f => f.path === this.path) ? this.path : files[0].path;
        this.select.value = wanted;
        this.load(wanted, path !== undefined);
    }

    load(path, force) {
        const file = this.host.files().find(f => f.path === path);
        if(!file || (!force && path === this.path && file.data === this.data)) {
            return;
        }
        const first = path !== this.path;
        this.path = path;
        this.data = file.data;
        this.vcd = readVcd(decoder.decode(file.data));
        if(first) {
            // Named signals first; the simulator's internal nodes (_6, _11...) are hidden at first.
            this.shown = new Set(this.vcd.signals.filter(s => !/^_\d+$/.test(s.name) && !/^(GND|Vdd|weak_)/.test(s.name)).map(s => s.name));
            this.span = null;
        }
        this.renderList();
        this.draw();
    }

    renderList() {
        this.list.textContent = "";
        for(const s of this.vcd?.signals || []) {
            const li = document.createElement("li");
            li.innerHTML = '<label><input type="checkbox"><span></span></label>';
            li.querySelector("input").checked = this.shown.has(s.name);
            li.querySelector("span").textContent = `${s.name} · ${s.changes.length}`;
            li.querySelector("input").addEventListener("change", e => {
                e.target.checked ? this.shown.add(s.name) : this.shown.delete(s.name);
                this.draw();
            });
            this.list.appendChild(li);
        }
    }

    draw() {
        if(!this.fw) {
            return;
        }
        const c = this.canvas, dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
        if(!w || !h) {
            return;
        }
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        const g = c.getContext("2d");
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const dark = matchMedia("(prefers-color-scheme: dark)").matches;
        const fg = dark ? "#e8e8ea" : "#1d1d1f", muted = dark ? "#6b6f76" : "#b0b3b8", wave = dark ? "#8fd3a4" : "#1e6b3a";
        g.fillStyle = dark ? "#111214" : "#fdfdfd";
        g.fillRect(0, 0, w, h);
        const rows = (this.vcd?.signals || []).filter(s => this.shown.has(s.name));
        if(!this.vcd) {
            this.info.textContent = "";
            return;
        }
        const end = Math.max(1, this.vcd.end);
        const [t0, t1] = this.span || [0, end * 1.05];
        const left = 110, rowH = 22, top = 18;
        const x = t => left + (t - t0) / (t1 - t0) * (w - left - 8);
        g.font = "11px ui-monospace, Menlo, monospace";
        g.fillStyle = muted;
        g.fillText(`${t0.toFixed(0)}`, left, 12);
        g.textAlign = "right";
        g.fillText(`${t1.toFixed(0)} ${this.vcd.timescale.replace(/^1/, "× ")}`, w - 8, 12);
        g.textAlign = "left";
        rows.forEach((s, r) => {
            const y = top + r * rowH, hi = y + 4, lo = y + rowH - 4;
            g.fillStyle = fg;
            g.fillText(s.name.length > 15 ? s.name.slice(0, 14) + "…" : s.name, 4, y + rowH / 2 + 4);
            g.strokeStyle = wave;
            g.lineWidth = 1.5;
            let prev = null;
            const changes = s.changes.length ? s.changes : [[0, "x"]];
            changes.forEach(([t, v], i) => {
                const next = i + 1 < changes.length ? changes[i + 1][0] : end;
                const xa = Math.max(left, x(t)), xb = Math.min(w - 8, x(next));
                if(xb < left || xa > w - 8) {
                    prev = v;
                    return;
                }
                if(v === "x" || v === "z" || s.width > 1) {
                    g.fillStyle = v === "x" ? "rgba(224, 49, 49, .35)" : "rgba(128, 128, 128, .3)";
                    g.fillRect(xa, hi, Math.max(1, xb - xa), lo - hi);
                    if(s.width > 1 && xb - xa > 30) {
                        g.fillStyle = fg;
                        g.fillText(v, xa + 3, lo - 3);
                    }
                } else {
                    const yv = v === "1" ? hi : lo;
                    g.beginPath();
                    if(prev !== null && prev !== v && (prev === "0" || prev === "1")) {
                        g.moveTo(xa, prev === "1" ? hi : lo);
                        g.lineTo(xa, yv);
                    } else {
                        g.moveTo(xa, yv);
                    }
                    g.lineTo(xb, yv);
                    g.stroke();
                }
                prev = v;
            });
            g.strokeStyle = muted;
            g.lineWidth = 0.5;
            g.beginPath();
            g.moveTo(left, y + rowH);
            g.lineTo(w - 8, y + rowH);
            g.stroke();
        });
        this.info.textContent = `${this.vcd.signals.length} signals · ${rows.length} shown · ends at ${this.vcd.end}`;
    }

    listen() {
        const c = this.canvas;
        c.addEventListener("wheel", e => {
            if(!this.vcd) {
                return;
            }
            e.preventDefault();
            const [t0, t1] = this.span || [0, Math.max(1, this.vcd.end) * 1.05];
            const r = c.getBoundingClientRect(), left = 110;
            const at = t0 + Math.max(0, e.clientX - r.left - left) / Math.max(1, c.clientWidth - left - 8) * (t1 - t0);
            const k = Math.exp(e.deltaY * 0.002);
            this.span = [at - (at - t0) * k, at + (t1 - at) * k];
            this.draw();
        }, {passive: false});
        let drag = null;
        c.addEventListener("pointerdown", e => {
            if(this.vcd) {
                drag = [e.clientX, this.span || [0, Math.max(1, this.vcd.end) * 1.05]];
                c.setPointerCapture(e.pointerId);
            }
        });
        c.addEventListener("pointermove", e => {
            if(drag) {
                const [x0, [t0, t1]] = drag, dt = (e.clientX - x0) / Math.max(1, c.clientWidth - 118) * (t1 - t0);
                this.span = [t0 - dt, t1 - dt];
                this.draw();
            }
        });
        c.addEventListener("pointerup", () => (drag = null));
    }
}
