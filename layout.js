// SPDX-License-Identifier: GPL-3.0-or-later
// The Layout window: GDS files (lm build's build/src/project.gds) drawn on a canvas.
//
// readGds() reads a GDSII stream (boundaries, paths, boxes, cell references and arrays, text);
// flatten() places every cell's shapes in the top cell's coordinates; the window draws them by
// layer, with the layer names of Loom's technology file (paint("name", gds layer, datatype)),
// and lets you pan (drag), zoom (wheel, pinch, buttons), pick the cell and hide layers.

import {FloatingWindow} from "./floating-window.js";
import {t, register, applyStatic} from "./i18n.js";

register({
    "GDS file": "GDS ファイル",
    "Cell": "セル",
    "Fit the cell to the window": "セル全体をウィンドウに収めます",
    "Fit": "全体表示",
    "Zoom in": "拡大",
    "Zoom out": "縮小",
    "Labels": "ラベル",
    "Layout": "レイアウト",
    "Layers": "レイヤー",
    "{name} (instance)": "{name}（インスタンス）",
    "(no .gds files: lm build writes build/src/project.gds)": "（.gds ファイルはありません。lm build で build/src/project.gds が書き出されます）",
    "Couldn't read {path}: {why}": "{path} を読み込めませんでした：{why}",
    "No layout": "レイアウトなし",
    " · 1 cell not in the cell library": " · セルライブラリにないセルが 1 個",
    " · {n} cells not in the cell library": " · セルライブラリにないセルが {n} 個",
    "{n} shapes{missing} · {w} × {h} µm": "図形 {n} 個{missing} · {w} × {h} µm",
    " (truncated)": "（途中まで）",
    "empty cell{missing}": "空のセル{missing}",
});

// ----- Reading GDSII

const REC = {
    HEADER: 0x00, BGNLIB: 0x01, LIBNAME: 0x02, UNITS: 0x03, ENDLIB: 0x04, BGNSTR: 0x05, STRNAME: 0x06, ENDSTR: 0x07,
    BOUNDARY: 0x08, PATH: 0x09, SREF: 0x0a, AREF: 0x0b, TEXT: 0x0c, LAYER: 0x0d, DATATYPE: 0x0e, WIDTH: 0x0f, XY: 0x10,
    ENDEL: 0x11, SNAME: 0x12, COLROW: 0x13, NODE: 0x15, TEXTTYPE: 0x16, STRING: 0x19, STRANS: 0x1a, MAG: 0x1b,
    ANGLE: 0x1c, PATHTYPE: 0x21, BOX: 0x2d, BOXTYPE: 0x2e,
};

// GDSII's 8-byte real: sign, excess-64 base-16 exponent, 56-bit mantissa.
function real8(view, p) {
    const b0 = view.getUint8(p);
    const sign = b0 & 0x80 ? -1 : 1, exponent = (b0 & 0x7f) - 64;
    let mantissa = 0;
    for(let i = 1; i < 8; i++) {
        mantissa = mantissa * 256 + view.getUint8(p + i);
    }
    return sign * mantissa / 2 ** 56 * 16 ** exponent;
}

export function readGds(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cells = new Map();
    let cell = null, el = null, units = [0.001, 1e-9], p = 0;
    const text = (start, len) => new TextDecoder().decode(bytes.subarray(start, start + len)).replace(/\0+$/, "");
    while(p + 4 <= bytes.length) {
        const len = view.getUint16(p), type = view.getUint8(p + 2);
        if(len < 4) {
            break;
        }
        const d = p + 4, n = len - 4;
        switch(type) {
        case REC.UNITS: units = [real8(view, d), real8(view, d + 8)]; break;
        case REC.BGNSTR: cell = {name: "", shapes: [], refs: [], texts: []}; break;
        case REC.STRNAME: cell.name = text(d, n); cells.set(cell.name, cell); break;
        case REC.ENDSTR: cell = null; break;
        case REC.BOUNDARY: case REC.BOX: el = {kind: "poly"}; break;
        case REC.PATH: el = {kind: "path", width: 0, pathtype: 0}; break;
        case REC.SREF: el = {kind: "ref", cols: 1, rows: 1}; break;
        case REC.AREF: el = {kind: "aref"}; break;
        case REC.TEXT: el = {kind: "text"}; break;
        case REC.NODE: el = {kind: "node"}; break;
        case REC.LAYER: el.layer = view.getInt16(d); break;
        case REC.DATATYPE: case REC.BOXTYPE: case REC.TEXTTYPE: el.datatype = view.getInt16(d); break;
        case REC.WIDTH: el.width = view.getInt32(d); break;
        case REC.PATHTYPE: el.pathtype = view.getInt16(d); break;
        case REC.SNAME: el.sname = text(d, n); break;
        case REC.COLROW: el.cols = view.getInt16(d); el.rows = view.getInt16(d + 2); break;
        case REC.STRANS: el.reflect = Boolean(view.getUint16(d) & 0x8000); break;
        case REC.MAG: el.mag = real8(view, d); break;
        case REC.ANGLE: el.angle = real8(view, d); break;
        case REC.STRING: el.string = text(d, n); break;
        case REC.XY: {
            const xy = [];
            for(let i = 0; i + 8 <= n; i += 8) {
                xy.push([view.getInt32(d + i), view.getInt32(d + i + 4)]);
            }
            el.xy = xy;
            break;
        }
        case REC.ENDEL:
            if(cell && el) {
                if(el.kind === "poly" || el.kind === "path") {
                    cell.shapes.push(el);
                } else if(el.kind === "ref" || el.kind === "aref") {
                    cell.refs.push(el);
                } else if(el.kind === "text") {
                    cell.texts.push(el);
                }
            }
            el = null;
            break;
        case REC.ENDLIB: p = bytes.length; continue;
        }
        p += len;
    }
    // Top cells: those no other cell references.
    const used = new Set();
    for(const c of cells.values()) {
        for(const r of c.refs) {
            used.add(r.sname);
        }
    }
    const tops = [...cells.keys()].filter(name => !used.has(name));
    return {cells, tops, units};
}

// A path's outline as a polygon (flush, round-as-square and extended ends approximated).
function pathPolygon(xy, width, pathtype) {
    const h = width / 2, ext = pathtype === 2 || pathtype === 1 ? h : 0;
    if(xy.length < 2 || !width) {
        return xy;
    }
    const left = [], right = [];
    for(let i = 0; i < xy.length; i++) {
        const prev = xy[Math.max(0, i - 1)], next = xy[Math.min(xy.length - 1, i + 1)];
        let [dx, dy] = [next[0] - prev[0], next[1] - prev[1]];
        const len = Math.hypot(dx, dy) || 1;
        [dx, dy] = [dx / len, dy / len];
        let [x, y] = xy[i];
        if(i === 0) {
            x -= dx * ext;
            y -= dy * ext;
        } else if(i === xy.length - 1) {
            x += dx * ext;
            y += dy * ext;
        }
        left.push([x - dy * h, y + dx * h]);
        right.push([x + dy * h, y - dx * h]);
    }
    return [...left, ...right.reverse()];
}

// Every shape of the cell, in its coordinates: [{layer, datatype, points}], and its labels.
export function flatten(gds, top, limit = 400000) {
    const shapes = [], labels = [];
    const visit = (name, m, depth) => {
        const cell = gds.cells.get(name);
        if(!cell || depth > 64 || shapes.length > limit) {
            return;
        }
        const tf = ([x, y]) => [m[0] * x + m[1] * y + m[4], m[2] * x + m[3] * y + m[5]];
        for(const s of cell.shapes) {
            const pts = s.kind === "path" ? pathPolygon(s.xy, s.width, s.pathtype) : s.xy;
            shapes.push({layer: s.layer, datatype: s.datatype || 0, points: pts.map(tf)});
        }
        for(const t of cell.texts) {
            if(t.xy?.length) {
                labels.push({layer: t.layer, datatype: t.datatype || 0, text: t.string || "", at: tf(t.xy[0])});
            }
        }
        for(const r of cell.refs) {
            const a = (r.angle || 0) * Math.PI / 180, k = r.mag || 1, f = r.reflect ? -1 : 1;
            // Reflect about x, magnify, rotate, then translate: the reference's own transform.
            const own = [k * Math.cos(a), -k * f * Math.sin(a), k * Math.sin(a), k * f * Math.cos(a)];
            const places = [];
            if(r.kind === "aref" && r.xy?.length >= 3) {
                const [o, c, rw] = r.xy;
                const cols = r.cols || 1, rows = r.rows || 1;
                for(let i = 0; i < cols; i++) {
                    for(let j = 0; j < rows; j++) {
                        places.push([o[0] + (c[0] - o[0]) * i / cols + (rw[0] - o[0]) * j / rows,
                            o[1] + (c[1] - o[1]) * i / cols + (rw[1] - o[1]) * j / rows]);
                    }
                }
            } else if(r.xy?.length) {
                places.push(r.xy[0]);
            }
            for(const [x, y] of places) {
                const child = [
                    m[0] * own[0] + m[1] * own[2], m[0] * own[1] + m[1] * own[3],
                    m[2] * own[0] + m[3] * own[2], m[2] * own[1] + m[3] * own[3],
                    m[0] * x + m[1] * y + m[4], m[2] * x + m[3] * y + m[5],
                ];
                visit(r.sname, child, depth + 1);
            }
        }
    };
    visit(top, [1, 0, 0, 1, 0, 0], 0);
    return {shapes, labels, truncated: shapes.length > limit};
}

// lm build's project.gds places cells that it lays out into its cell library
// (sky130/cells/cell_<id>.gds), leaving an empty cell of the same name in the file
// ("wv-<module>.cell_<id>-<hash>").  Fill those from the library; returns the names not found.
const cellId = name => /cell_[a-z0-9]+/i.exec(name)?.[0];

export function withLibrary(gds, libraryFiles) {
    const byId = new Map();
    for(const f of libraryFiles) {
        const id = /\.gds$/i.test(f.path) && cellId(f.path.split("/").pop());
        if(id) {
            byId.set(id, f);
        }
    }
    const missing = [];
    for(const [name, cell] of gds.cells) {
        if(cell.shapes.length || cell.refs.length || cell.texts.length) {
            continue;
        }
        const file = byId.get(cellId(name));
        if(!file) {
            if(cellId(name)) {
                missing.push(name);
            }
            continue;
        }
        const lib = readGds(file.data);
        const top = lib.cells.get(lib.tops[0]) || [...lib.cells.values()][0];
        if(top) {
            Object.assign(cell, {shapes: top.shapes, refs: top.refs, texts: top.texts});
            for(const [other, c] of lib.cells) {
                if(c !== top && !gds.cells.has(other)) {
                    gds.cells.set(other, c);
                }
            }
        }
    }
    return missing;
}

// ----- Layer names and colours

// paint("name", layer, datatype) lines of a Loom technology file.
export function layerNames(techText) {
    const names = new Map();
    for(const m of techText.matchAll(/paint\(\s*["']([^"']+)["']\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
        names.set(`${m[2]}/${m[3]}`, m[1]);
    }
    return names;
}

const COLOURS = {
    nwell: "#b9a77a", dnwell: "#8f7d55", diff: "#2f9e44", tap: "#5c940d", poly: "#e03131", licon1: "#495057",
    li1: "#7048e8", mcon: "#343a40", met1: "#1c7ed6", via: "#0b7285", met2: "#d6336c", via2: "#5f3dc4",
    met3: "#f08c00", via3: "#862e9c", met4: "#0ca678", via4: "#364fc7", met5: "#c2255c", nsdm: "#74b816",
    psdm: "#f59f00", npc: "#868e96", hvtp: "#ae3ec9", lvtn: "#4dabf7", areaid: "#adb5bd", prbndry: "#495057",
};

function colourFor(name, key) {
    const base = (name || "").split(".")[0];
    if(COLOURS[base]) {
        return COLOURS[base];
    }
    let h = 0;
    for(const ch of key) {
        h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    }
    return `hsl(${h % 360} 55% 50%)`;
}

// ----- The window

export class LayoutWindow {
    // host: {desktop, files(): [{path, data}], library(): [{path, data}] (lm's cell library),
    //        techText(): Promise<string>, print}
    constructor(host) {
        this.host = host;
        this.fw = null;
        this.path = null;
        this.gds = null;
        this.top = null;
        this.flat = null;
        this.hidden = new Set();
        this.view = null;            // {scale, ox, oy}: screen = (x * scale + ox, oy - y * scale)
        this.names = new Map();
    }

    isOpen() {
        return Boolean(this.fw);
    }

    open(path) {
        if(!this.fw) {
            const d = this.host.desktop;
            this.fw = new FloatingWindow(d, {title: "Layout", x: Math.max(12, d.clientWidth - 640), y: 12,
                width: Math.min(620, d.clientWidth - 24), height: Math.min(460, d.clientHeight - 24), onClose: () => this.close()});
            this.fw.body.innerHTML = `<div class="lay-body">
                <div class="lay-bar"><select data-act="file" data-i18n-aria-label="GDS file"></select><select data-act="cell" data-i18n-aria-label="Cell"></select>
                <button type="button" data-act="fit" data-i18n-title="Fit the cell to the window" data-i18n="Fit"></button>
                <button type="button" data-act="in" data-i18n-aria-label="Zoom in">+</button><button type="button" data-act="out" data-i18n-aria-label="Zoom out">−</button>
                <label><input type="checkbox" data-act="labels" checked> <span data-i18n="Labels"></span></label><span class="lay-info"></span></div>
                <div class="lay-main"><canvas data-i18n-aria-label="Layout"></canvas><ul class="lay-layers" data-i18n-aria-label="Layers"></ul></div></div>`;
            applyStatic(this.fw.body);
            this.canvas = this.fw.body.querySelector("canvas");
            this.layers = this.fw.body.querySelector(".lay-layers");
            this.info = this.fw.body.querySelector(".lay-info");
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

    // The GDS files of the project, and the one shown (path, or the first).
    async refresh(path) {
        if(!this.fw) {
            return;
        }
        if(!this.names.size) {
            try {
                this.names = layerNames(await this.host.techText());
            } catch(error) {
                // Layer numbers only
            }
        }
        const files = this.host.files().filter(f => /\.gds$/i.test(f.path));
        const select = this.fw.body.querySelector("[data-act=file]");
        select.textContent = "";
        for(const f of files) {
            select.add(new Option(f.path, f.path));
        }
        if(!files.length) {
            select.add(new Option(t("(no .gds files: lm build writes build/src/project.gds)"), ""));
        }
        const wanted = path || (files.some(f => f.path === this.path) ? this.path : files[0]?.path);
        if(wanted) {
            select.value = wanted;
            this.load(files.find(f => f.path === wanted), path !== undefined || wanted !== this.path);
        } else {
            this.gds = this.flat = null;
            this.path = null;
            this.draw();
        }
    }

    load(file, refit) {
        if(!file) {
            return;
        }
        const sameFile = this.path === file.path && this.data === file.data;
        this.path = file.path;
        this.data = file.data;
        if(sameFile && this.flat) {
            return;
        }
        try {
            this.gds = readGds(file.data);
            this.missing = withLibrary(this.gds, this.host.library());
        } catch(error) {
            this.host.print(t("Couldn't read {path}: {why}", {path: file.path, why: error.message || error}), "error");
            return;
        }
        const cells = this.fw.body.querySelector("[data-act=cell]");
        cells.textContent = "";
        const order = [...this.gds.tops, ...[...this.gds.cells.keys()].filter(n => !this.gds.tops.includes(n))];
        for(const name of order) {
            cells.add(new Option(this.gds.tops.includes(name) ? name : t("{name} (instance)", {name}), name));
        }
        // The top cell with the most shapes underneath, which is usually the design.
        const size = name => flatten(this.gds, name, 50000).shapes.length;
        const top = this.gds.tops.includes(this.top) ? this.top : this.gds.tops.slice().sort((a, b) => size(b) - size(a))[0] || order[0];
        cells.value = top;
        this.showCell(top, refit || !sameFile);
    }

    showCell(name, refit) {
        this.top = name;
        this.flat = name ? flatten(this.gds, name) : null;
        this.renderLayers();
        if(refit || !this.view) {
            this.fit();
        }
        this.draw();
    }

    keyOf(s) {
        return `${s.layer}/${s.datatype}`;
    }

    renderLayers() {
        this.layers.textContent = "";
        if(!this.flat) {
            return;
        }
        const counts = new Map();
        for(const s of this.flat.shapes) {
            counts.set(this.keyOf(s), (counts.get(this.keyOf(s)) || 0) + 1);
        }
        const keys = [...counts.keys()].sort((a, b) => {
            const [la, da] = a.split("/").map(Number), [lb, db] = b.split("/").map(Number);
            return la - lb || da - db;
        });
        for(const key of keys) {
            const name = this.names.get(key) || key;
            const li = document.createElement("li");
            li.innerHTML = `<label><input type="checkbox"${this.hidden.has(key) ? "" : " checked"}><i></i><span></span></label>`;
            li.querySelector("i").style.background = colourFor(name, key);
            li.querySelector("span").textContent = `${name} (${key}) · ${counts.get(key)}`;
            li.querySelector("input").addEventListener("change", e => {
                e.target.checked ? this.hidden.delete(key) : this.hidden.add(key);
                this.draw();
            });
            this.layers.appendChild(li);
        }
    }

    bounds() {
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
        for(const s of this.flat?.shapes || []) {
            for(const [x, y] of s.points) {
                x0 = Math.min(x0, x);
                y0 = Math.min(y0, y);
                x1 = Math.max(x1, x);
                y1 = Math.max(y1, y);
            }
        }
        return x0 === Infinity ? null : [x0, y0, x1, y1];
    }

    fit() {
        const b = this.bounds(), w = this.canvas.clientWidth || 400, h = this.canvas.clientHeight || 300;
        if(!b) {
            this.view = {scale: 1, ox: w / 2, oy: h / 2};
            return;
        }
        const scale = 0.92 * Math.min(w / Math.max(1, b[2] - b[0]), h / Math.max(1, b[3] - b[1]));
        this.view = {scale, ox: w / 2 - scale * (b[0] + b[2]) / 2, oy: h / 2 + scale * (b[1] + b[3]) / 2};
    }

    zoom(factor, cx, cy) {
        const v = this.view;
        cx ??= this.canvas.clientWidth / 2;
        cy ??= this.canvas.clientHeight / 2;
        v.ox = cx - (cx - v.ox) * factor;
        v.oy = cy - (cy - v.oy) * factor;
        v.scale *= factor;
        this.draw();
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
        g.fillStyle = dark ? "#111214" : "#fdfdfd";
        g.fillRect(0, 0, w, h);
        if(!this.flat) {
            this.info.textContent = this.gds ? "" : t("No layout");
            return;
        }
        const v = this.view || (this.fit(), this.view);
        const byKey = new Map();
        for(const s of this.flat.shapes) {
            const key = this.keyOf(s);
            if(!this.hidden.has(key)) {
                (byKey.get(key) || byKey.set(key, []).get(key)).push(s);
            }
        }
        const units = this.gds.units[1] * 1e6;       // database unit in micrometres
        for(const [key, shapes] of [...byKey].sort((a, b) => Number(a[0].split("/")[0]) - Number(b[0].split("/")[0]))) {
            const colour = colourFor(this.names.get(key), key);
            g.beginPath();
            for(const s of shapes) {
                s.points.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, x * v.scale + v.ox, v.oy - y * v.scale));
                g.closePath();
            }
            g.globalAlpha = 0.35;
            g.fillStyle = colour;
            g.fill("evenodd");
            g.globalAlpha = 0.9;
            g.strokeStyle = colour;
            g.lineWidth = 1;
            g.stroke();
        }
        g.globalAlpha = 1;
        if(this.fw.body.querySelector("[data-act=labels]").checked) {
            g.font = "11px ui-monospace, Menlo, monospace";
            g.fillStyle = dark ? "#e8e8ea" : "#1d1d1f";
            for(const l of this.flat.labels) {
                if(!this.hidden.has(this.keyOf(l))) {
                    g.fillText(l.text, l.at[0] * v.scale + v.ox + 2, v.oy - l.at[1] * v.scale - 2);
                }
            }
        }
        const b = this.bounds();
        const n = this.missing?.length || 0;
        const missing = n ? t(n === 1 ? " · 1 cell not in the cell library" : " · {n} cells not in the cell library", {n}) : "";
        this.info.textContent = b ? t("{n} shapes{missing} · {w} × {h} µm", {n: this.flat.shapes.length, missing,
            w: ((b[2] - b[0]) * units).toFixed(2), h: ((b[3] - b[1]) * units).toFixed(2)}) + (this.flat.truncated ? t(" (truncated)") : "") :
            t("empty cell{missing}", {missing});
    }

    listen() {
        const body = this.fw.body;
        body.querySelector(".lay-bar").addEventListener("change", e => {
            const act = e.target.dataset.act;
            if(act === "file") {
                this.load(this.host.files().find(f => f.path === e.target.value), true);
            } else if(act === "cell") {
                this.showCell(e.target.value, true);
            } else if(act === "labels") {
                this.draw();
            }
        });
        body.querySelector(".lay-bar").addEventListener("click", e => {
            const act = e.target.closest("button")?.dataset.act;
            if(act === "fit") {
                this.fit();
                this.draw();
            } else if(act === "in" || act === "out") {
                this.zoom(act === "in" ? 1.5 : 1 / 1.5);
            }
        });
        const c = this.canvas;
        c.addEventListener("wheel", e => {
            e.preventDefault();
            const r = c.getBoundingClientRect();
            this.zoom(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.002)), e.clientX - r.left, e.clientY - r.top);
        }, {passive: false});
        const pointers = new Map();
        let pinch = null;
        c.addEventListener("pointerdown", e => {
            c.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, [e.clientX, e.clientY]);
            pinch = null;
        });
        c.addEventListener("pointermove", e => {
            const last = pointers.get(e.pointerId);
            if(!last || !this.view) {
                return;
            }
            const now = [e.clientX, e.clientY];
            pointers.set(e.pointerId, now);
            if(pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                const dist = Math.hypot(a[0] - b[0], a[1] - b[1]), r = c.getBoundingClientRect();
                if(pinch) {
                    this.zoom(dist / pinch, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
                }
                pinch = dist;
                return;
            }
            this.view.ox += now[0] - last[0];
            this.view.oy += now[1] - last[1];
            this.draw();
        });
        const up = e => {
            pointers.delete(e.pointerId);
            pinch = null;
        };
        c.addEventListener("pointerup", up);
        c.addEventListener("pointercancel", up);
    }
}
