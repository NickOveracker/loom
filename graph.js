// SPDX-License-Identifier: GPL-3.0-or-later
// The Graph window: the Graphviz files lm show writes (build/dbg/.../<process>.dot), drawn as
// SVG by Graphviz in viz-worker.js.  Petri nets of CHP and HSE processes, mostly.  Drag to pan,
// wheel or the buttons to zoom.

import {FloatingWindow} from "./floating-window.js";
import {t, register, applyStatic} from "./i18n.js";

register({
    "Graph file": "グラフのファイル",
    "Fit": "全体表示",
    "Zoom in": "拡大",
    "Zoom out": "縮小",
    "Download SVG": "SVG をダウンロード",
    "(no graphs: lm show writes them)": "（グラフはありません。lm show で書き出せます）",
    "Drawing…": "描画中…",
    "Graphviz couldn't draw {path}: {why}": "Graphviz で {path} を描画できませんでした：{why}",
    "Graph of {path}": "{path} のグラフ",
});

let worker = null, nextId = 1;
const pending = new Map();

function render(dot) {
    if(!worker) {
        worker = new Worker(new URL("viz-worker.js", import.meta.url));
        worker.onmessage = event => {
            const {id, svg, error} = event.data;
            const p = pending.get(id);
            pending.delete(id);
            error ? p?.reject(new Error(error)) : p?.resolve(svg);
        };
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject});
        worker.postMessage({id, dot});
    });
}

const decoder = new TextDecoder();

export class GraphWindow {
    // host: {desktop, files(): [{path, data}], print, saveBlob}
    constructor(host) {
        this.host = host;
        this.fw = null;
        this.path = null;
        this.scale = 1;
    }

    isOpen() {
        return Boolean(this.fw);
    }

    open(path) {
        if(!this.fw) {
            const d = this.host.desktop;
            this.fw = new FloatingWindow(d, {title: "Graph", x: 24, y: Math.min(140, Math.max(12, d.clientHeight - 360)),
                width: Math.min(560, d.clientWidth - 48), height: Math.min(400, d.clientHeight - 24), onClose: () => this.close()});
            this.fw.body.innerHTML = `<div class="gr-body"><div class="lay-bar"><select data-i18n-aria-label="Graph file"></select>
                <button type="button" data-act="fit" data-i18n="Fit"></button><button type="button" data-act="in" data-i18n-aria-label="Zoom in">+</button>
                <button type="button" data-act="out" data-i18n-aria-label="Zoom out">−</button><button type="button" data-act="svg" data-i18n="Download SVG"></button>
                <span class="lay-info"></span></div><div class="gr-view"><div class="gr-svg"></div></div></div>`;
            applyStatic(this.fw.body);
            this.select = this.fw.body.querySelector("select");
            this.view = this.fw.body.querySelector(".gr-view");
            this.holder = this.fw.body.querySelector(".gr-svg");
            this.info = this.fw.body.querySelector(".lay-info");
            this.select.addEventListener("change", () => this.show(this.select.value));
            this.fw.body.querySelector(".lay-bar").addEventListener("click", e => {
                const act = e.target.closest("button")?.dataset.act;
                if(act === "fit") {
                    this.fit();
                } else if(act === "in" || act === "out") {
                    this.setScale(this.scale * (act === "in" ? 1.4 : 1 / 1.4));
                } else if(act === "svg" && this.svg) {
                    this.host.saveBlob(this.path.split("/").pop().replace(/\.dot$/, ".svg"), new Blob([this.svg], {type: "image/svg+xml"}));
                }
            });
            this.view.addEventListener("wheel", e => {
                if(e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this.setScale(this.scale * Math.exp(-e.deltaY * 0.002));
                }
            }, {passive: false});
            let drag = null;
            this.view.addEventListener("pointerdown", e => {
                drag = [e.clientX, e.clientY, this.view.scrollLeft, this.view.scrollTop];
                this.view.setPointerCapture(e.pointerId);
            });
            this.view.addEventListener("pointermove", e => {
                if(drag) {
                    this.view.scrollLeft = drag[2] - (e.clientX - drag[0]);
                    this.view.scrollTop = drag[3] - (e.clientY - drag[1]);
                }
            });
            this.view.addEventListener("pointerup", () => (drag = null));
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
        const files = this.host.files().filter(f => /\.(dot|gv)$/i.test(f.path));
        this.select.textContent = "";
        for(const f of files) {
            this.select.add(new Option(f.path, f.path));
        }
        if(!files.length) {
            this.select.add(new Option(t("(no graphs: lm show writes them)"), ""));
            this.holder.textContent = "";
            this.info.textContent = "";
            return;
        }
        const wanted = path && files.some(f => f.path === path) ? path : files.some(f => f.path === this.path) ? this.path : files[0].path;
        this.select.value = wanted;
        this.show(wanted, path !== undefined);
    }

    async show(path, force = false) {
        const file = this.host.files().find(f => f.path === path);
        if(!file || (!force && path === this.path && file.data === this.data)) {
            return;
        }
        this.path = path;
        this.data = file.data;
        this.info.textContent = t("Drawing…");
        try {
            this.svg = await render(decoder.decode(file.data));
        } catch(error) {
            this.info.textContent = "";
            this.holder.textContent = t("Graphviz couldn't draw {path}: {why}", {path, why: error.message});
            return;
        }
        if(this.path !== path) {
            return;
        }
        // As an image, so that nothing in a project's graph (links, scripts) runs in the page.
        const size = /<svg[^>]*\bwidth="([\d.]+)pt"[^>]*\bheight="([\d.]+)pt"/.exec(this.svg);
        this.natural = size ? [Number(size[1]) * 4 / 3, Number(size[2]) * 4 / 3] : [400, 300];
        URL.revokeObjectURL(this.url);
        this.url = URL.createObjectURL(new Blob([this.svg], {type: "image/svg+xml"}));
        this.holder.innerHTML = "";
        const img = document.createElement("img");
        img.alt = t("Graph of {path}", {path});
        img.draggable = false;
        img.src = this.url;
        this.holder.appendChild(img);
        this.info.textContent = "";
        this.fit();
    }

    setScale(scale) {
        const img = this.holder.querySelector("img");
        if(!img) {
            return;
        }
        this.scale = Math.max(0.05, Math.min(20, scale));
        img.style.width = `${this.natural[0] * this.scale}px`;
        img.style.height = `${this.natural[1] * this.scale}px`;
        this.info.textContent = `${Math.round(this.scale * 100)}%`;
    }

    fit() {
        if(this.natural) {
            this.setScale(Math.min(1.5, (this.view.clientWidth - 16) / this.natural[0], (this.view.clientHeight - 16) / this.natural[1]));
        }
    }
}
