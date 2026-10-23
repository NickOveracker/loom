// SPDX-License-Identifier: GPL-3.0-or-later
// Loom in the browser: Broccoli's circuit compiler (lm) compiled to WebAssembly.
//
// The console runs lm commands (lm build, lm sim, lm show, lm mod...) on the project's files,
// each in a fresh instance of the module in a worker (session.js, worker.js), and takes the
// simulators' commands while one runs.  What lm writes comes back into the project, and the
// windows show it: Files (view and edit), Layout (the GDS lm build lays out), Graph (the
// Graphviz files lm show writes) and Waves (the .vcd lm sim records).  Projects are files,
// folders or archives, kept in a folder on disk or in the browser's storage, as in the Magic,
// IRSIM and netgen apps.

import {Session} from "./session.js";
import {LayoutWindow} from "./layout.js";
import {GraphWindow} from "./graph.js";
import {WavesWindow} from "./waves.js";
import {FloatingWindow, topEdgeResizer, paneResizer} from "./floating-window.js";
import {menuBar, closeMenus} from "./menu.js";
import {ask, setHomeFocus} from "./dialog.js";
import {readArchive, isArchive, stripCommonFolder, cleanPath, writeTarGz} from "./archive.js";
import {diskSupported, DiskStore, BrowserStore, recentProjects, reopen, forget} from "./storage.js";
import {t, register, applyStatic, languageButton, onLanguageChange} from "./i18n.js";

const $ = selector => document.querySelector(selector);
const desktop = $("#desktop");
const log = $("#log");
const commandInput = $("#command");
const promptLabel = $("#prompt");
const statusEl = $("#status");
const here = path => new URL(path, import.meta.url);

// The page's text in Japanese (i18n.js); the English is in the code.  lm's own output,
// commands and file names stay as they are.
register({
    // Menus and windows
    "Page menu": "ページメニュー",
    // The page (index.html)
    "circuit compiler · WebAssembly": "回路コンパイラー · WebAssembly",
    "Help": "ヘルプ",
    "Stop": "停止",
    "Stop the command that is running": "実行中のコマンドを停止します",
    "Loading…": "読み込み中…",
    "Support Broccoli, who make Loom, through GitHub Sponsors": "Loom の開発元 Broccoli を GitHub Sponsors で支援します",
    "Sponsor Loom's makers": "Loom の開発者を支援",
    "Loom windows": "Loom のウィンドウ",
    "Loom console": "Loom のコンソール",
    "Show or hide the console": "コンソールの表示／非表示",
    "Project": "プロジェクト",
    "Examples": "サンプル",
    "Windows": "ウィンドウ",
    "About": "情報",
    "Files": "ファイル",
    "Layout": "レイアウト",
    "Graph": "グラフ",
    "Waves": "波形",
    "Resize the console": "コンソールのサイズを変更",
    "Resize the file list": "ファイル一覧の幅を変更",
    "New project…": "新しいプロジェクト…",
    "Open files…": "ファイルを開く…",
    "Open folder (copy)…": "フォルダーを開く（コピー）…",
    "Add files to project…": "プロジェクトにファイルを追加…",
    "Copy files into the open project": "開いているプロジェクトにファイルをコピーします",
    "Work in a folder on disk…": "ディスク上のフォルダーで作業…",
    "Open a folder; what lm writes and your edits are saved into it":
        "フォルダーを開きます。lm が書き出すファイルと編集内容はそこに保存されます",
    "Save project to a folder on disk…": "プロジェクトをディスク上のフォルダーに保存…",
    "Copy this project into a folder and keep working there": "このプロジェクトをフォルダーにコピーし、そこで作業を続けます",
    "Keep project in browser storage": "プロジェクトをブラウザーのストレージに保存",
    "Saves into this browser (private to this site) and keeps it there":
        "このブラウザー内（このサイト専用）に保存し、以後もそこに保存します",
    "Needs Chrome, Edge or another Chromium browser (the File System Access API)":
        "Chrome、Edge などの Chromium 系ブラウザーが必要です（File System Access API）",
    "Reopen {name} (folder)": "{name} を再び開く（フォルダー）",
    "Reopen {name} (browser storage)": "{name} を再び開く（ブラウザーのストレージ）",
    "Forget recent projects…": "最近のプロジェクトを消去…",
    "Forget the recent projects? Folders on disk are not touched.":
        "最近のプロジェクトの一覧を消去しますか？ディスク上のフォルダーには手を加えません。",
    "Forget the recent projects? This deletes {names} from browser storage. Folders on disk are not touched.":
        "最近のプロジェクトの一覧を消去しますか？ブラウザーのストレージから {names} を削除します。ディスク上のフォルダーには手を加えません。",
    "Build (lm build)": "ビルド（lm build）",
    "Draw the processes (lm show)": "プロセスを図示（lm show）",
    "List the modules (lm mod show)": "モジュールの一覧（lm mod show）",
    "Download project (.tar.gz)": "プロジェクトをダウンロード（.tar.gz）",
    "Loom's tutorial: functions to Verilog, a buffer to a layout": "Loom のチュートリアル：関数から Verilog へ、バッファーからレイアウトへ",
    "WCHB buffer, from its handshaking expansion (cog)": "WCHB バッファー（ハンドシェイク展開から、cog）",
    "A stream of WCHB buffers (cog)": "WCHB バッファーの連なり（cog）",
    "Loom (Broccoli)": "Loom（Broccoli）",
    "Loom's documentation": "Loom のドキュメント",
    "Loom upstream source": "Loom の本家のソース",
    "Sponsor Broccoli, Loom's makers, on GitHub": "Loom の開発元 Broccoli を GitHub で支援",
    "Support this unofficial fork on Ko-fi": "この非公式フォークを Ko-fi で支援",
    "Loom license (GPL 3)": "Loom のライセンス（GPL 3）",
    "Web app license (GPL 3 or later)": "ウェブアプリのライセンス（GPL 3 以降）",
    "gdstk license (Boost)": "gdstk のライセンス（Boost）",
    "Qhull license": "Qhull のライセンス",
    "OpenCL headers license (Apache 2.0)": "OpenCL ヘッダーのライセンス（Apache 2.0）",
    "Graphviz license (EPL 2.0), drawing graphs": "Graphviz のライセンス（EPL 2.0、グラフの描画）",
    "Viz.js license (MIT)": "Viz.js のライセンス（MIT）",
    "Emscripten runtime license (MIT)": "Emscripten ランタイムのライセンス（MIT）",
    "This web app's source": "このウェブアプリのソース",
    // Dialogs
    "New project": "新しいプロジェクト",
    "An empty project with lm.mod and src/top.wv (lm mod init).": "lm.mod と src/top.wv だけの空のプロジェクトです（lm mod init）。",
    "Module name": "モジュール名",
    "Create": "作成",
    "New file": "新しいファイル",
    "File name": "ファイル名",
    "Delete {path} from the project?": "{path} をプロジェクトから削除しますか？",
    "Delete {path} from the project? (It stays in {where}.)": "{path} をプロジェクトから削除しますか？（{where} には残ります。）",
    // The Files window
    "Save": "保存",
    "Write the file (Ctrl+S)": "ファイルを書き込みます（Ctrl+S）",
    "Show": "表示",
    "Show it in the Layout, Graph or Waves window": "レイアウト、グラフ、波形のいずれかのウィンドウで表示します",
    "New…": "新規…",
    "Delete": "削除",
    "Download": "ダウンロード",
    "Project files": "プロジェクトのファイル",
    "File contents": "ファイルの内容",
    "({n} bytes of binary data)": "（{n} バイトのバイナリデータ）",
    "({n} bytes of binary data: Show draws the layout)": "（{n} バイトのバイナリデータ。「表示」でレイアウトを描画します）",
    "({n} bytes: too big to show)": "（{n} バイト。大きすぎて表示できません）",
    // The console and status
    "A simulator command (help, e, s, t, q…); Stop ends the simulation": "シミュレーターのコマンド（help, e, s, t, q…）。「停止」でシミュレーションを終了します",
    "build · sim build/src/<file>.prs · show · mod show · help": "build · sim build/src/<file>.prs · show · mod show · help",
    "{command}: waiting for a command": "{command}：コマンド待ち",
    "Running lm {command}…": "lm {command} を実行中…",
    "Ready": "準備完了",
    " · not saved to {where}!": " · {where} に保存できていません！",
    " · kept in {where}": " · {where} に保存中",
    " · in memory only": " · メモリ上のみ",
    "lm stopped: {why}": "lm が停止しました：{why}",
    "Couldn't save to {where}: {why}": "{where} に保存できませんでした：{why}",
    "lm deleted {files}; they are still in {where}.": "lm が {files} を削除しました。{where} には残っています。",
    "Wrote {files} ({seconds} s)": "{files} を書き出しました（{seconds} 秒）",
    "{files} and {n} more": "{files} ほか {n} 件",
    "Opened {name}: {files}": "{name} を開きました：{files}",
    "Opened {name}: no files yet": "{name} を開きました：まだファイルはありません",
    "This project has no lm.mod: lm mod init <name> makes one (lm build needs it to find the sources in src/).":
        "このプロジェクトには lm.mod がありません。lm mod init <name> で作成できます（lm build が src/ のソースを見つけるのに必要です）。",
    "Loading {name}…": "{name} を読み込み中…",
    "Couldn't load the example {url}: HTTP {status}": "サンプル {url} を読み込めませんでした：HTTP {status}",
    "Reading {where}…": "{where} を読み込み中…",
    "Working in {where}: what lm writes and your edits are saved there.": "{where} で作業しています。lm が書き出すファイルと編集内容はそこに保存されます。",
    "Saved 1 file to {where}; later changes go there too.": "1 個のファイルを {where} に保存しました。以後の変更もそこに保存されます。",
    "Saved {n} files to {where}; later changes go there too.": "{n} 個のファイルを {where} に保存しました。以後の変更もそこに保存されます。",
    "Saved 1 file to {name}": "1 個のファイルを {name} に保存しました",
    "Saved {n} files to {name}": "{n} 個のファイルを {name} に保存しました",
    "Wrote {path}": "{path} を書き込みました",
    "Added {files}": "{files} を追加しました",
    "lm is still running; wait for it, or Stop it.": "lm はまだ実行中です。終わるのを待つか、「停止」してください。",
    "Stopped lm {command}.": "lm {command} を停止しました。",
    "Drop a Loom project folder, source files (.wv, .cogw, .prs…), or a .zip / .tar.gz to open it":
        "Loom のプロジェクトのフォルダー、ソースファイル（.wv, .cogw, .prs…）、または .zip / .tar.gz をドロップすると開きます",
    "Loom{version}, Copyright (C) 2024 Broccoli, LLC; changed for this WebAssembly build in 2026 (the changes are listed in the source, About > This web app's source).":
        "Loom{version}、Copyright (C) 2024 Broccoli, LLC。2026 年にこの WebAssembly 版のために変更されています（変更点はソースに記載。「情報」>「このウェブアプリのソース」）。",
    "Loom comes with ABSOLUTELY NO WARRANTY. It is free software: you may redistribute it under the terms of the GNU General Public License, version 3; About > Loom license shows a copy.":
        "Loom は完全に無保証です。Loom はフリーソフトウェアであり、GNU 一般公衆利用許諾書（GPL）第 3 版の条件のもとで再頒布できます。その写しは「情報」>「Loom のライセンス」にあります。",
});

topEdgeResizer($("#console"), desktop, {label: "Resize the console"});

// Each example: a folder, examples/<name>/, of the files it lists, and the commands it runs
// when it opens.
const EXAMPLES = {
    tutorial: {label: "Loom's tutorial: functions to Verilog, a buffer to a layout",
        files: ["lm.mod", "src/top.wv", "src/buffer.wv", "README.txt"], run: ["build", "show"]},
    wchb1b: {label: "WCHB buffer, from its handshaking expansion (cog)", files: ["lm.mod", "src/wchb1b.cogw", "README.txt"],
        run: ["build", "show"]},
    wchb_stream: {label: "A stream of WCHB buffers (cog)", files: ["lm.mod", "src/wchb_stream.cogw", "README.txt"], run: ["build", "show"]},
};
const DEFAULT_EXAMPLE = "tutorial";
const SOURCES = /\.(wv|cog|cogw|chp|hse|prs|astg|spi|spice|v|sim|mod|gc)$/i;

let project = null;          // {name, files: [{path, data}], store, syncError}
// lm's cell library: the cells lm build lays out (sky130/cells/cell_<id>.gds, .lef, .spi), which
// lm keeps in the technology folder, outside the project, and reuses in later builds.
const library = new Map();   // path under the technology folder -> data

// ----- Output

function print(text, kind) {
    const line = document.createElement("div");
    line.className = "log-line" + (kind ? " log-" + kind : "");
    line.textContent = text;
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.appendChild(line);
    while(log.childElementCount > 5000) {
        log.firstElementChild.remove();
    }
    if(atBottom) {
        log.scrollTop = log.scrollHeight;
    }
}

function saveBlob(name, blob) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// Loom's messages name the files of the build machine (src/lib/...: the source of the message);
// the console shows them shorter.  Errors and warnings are coloured.
function kindOf(text, error) {
    if(error || /(^|: )(error|internal failure|err):/i.test(text)) {
        return "error";
    }
    return /(^|: )warning:/i.test(text) ? "warning" : null;
}
const tidy = text => text.replace(/^\/[^\s:]*\/src\/(lib|bin)\/[^\s:]*:\d+: /, "").replace(/^\/work\//, "");

// ----- The session

const session = new Session({
    onOutput: (text, error) => print(tidy(text), kindOf(text, error)),
    onPrompt: () => {
        promptLabel.textContent = session.prompt || "sim>";
        commandInput.placeholder = t("A simulator command (help, e, s, t, q…); Stop ends the simulation");
        home();
    },
    onState: () => updateStatus(),
});

function updateStatus() {
    $("#stop").hidden = !session.busy;
    if(!session.waiting) {
        promptLabel.textContent = "lm";
        commandInput.placeholder = t("build · sim build/src/<file>.prs · show · mod show · help");
    }
    if(session.busy) {
        statusEl.textContent = session.waiting ? t("{command}: waiting for a command", {command: session.current}) :
            t("Running lm {command}…", {command: session.current.slice(0, 60)});
        return;
    }
    if(!project) {
        statusEl.textContent = t("Ready");
        return;
    }
    const where = project.store ? t(project.syncError ? " · not saved to {where}!" : " · kept in {where}", {where: project.store.label}) :
        t(" · in memory only");
    statusEl.textContent = `${project.name}${where}`;
}

// Split a command line into arguments, with "quoted" or 'quoted' parts kept whole.
function splitArgs(line) {
    const args = [];
    for(const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
        args.push(m[1] ?? m[2] ?? m[3]);
    }
    return args;
}

// Run a console line: a simulator's command while one waits, otherwise an lm command
// ("lm" in front is optional).
async function run(line, {echo = true} = {}) {
    if(session.waiting) {
        print(`${promptLabel.textContent} ${line}`, "command");
        session.line(line);
        return null;
    }
    if(echo) {
        print("lm> " + line, "command");
    }
    let argv = splitArgs(line);
    if(argv[0] === "lm") {
        argv = argv.slice(1);
    }
    if(!argv.length) {
        return null;
    }
    if(argv[0] === "clear" && argv.length === 1) {
        log.textContent = "";
        return null;
    }
    if(!project) {
        project = {name: "untitled", files: [], store: null};
    }
    let reply;
    try {
        reply = await session.run(argv, project.files, [...library].map(([path, data]) => ({path, data})));
    } catch(error) {
        if(error.message !== "stopped") {
            print(String(error.message || error), "error");
        }
        return null;
    }
    if(reply.error) {
        print(t("lm stopped: {why}", {why: reply.error}), "error");
    }
    await absorb(reply, argv);
    return reply;
}

// Take what lm wrote into the project, keep it, and show it.
async function absorb(reply, argv) {
    const current = project;
    for(const f of reply.cells || []) {
        library.set(f.path, f.data);
    }
    for(const f of reply.changed) {
        const known = current.files.find(x => x.path === f.path);
        known ? (known.data = f.data) : current.files.push({path: f.path, data: f.data});
    }
    current.files = current.files.filter(f => !reply.removed.includes(f.path));
    if(reply.changed.length && current.store) {
        try {
            for(const f of reply.changed) {
                await current.store.write(f.path, f.data);
            }
            current.syncError = null;
        } catch(error) {
            current.syncError = error;
            print(t("Couldn't save to {where}: {why}", {where: current.store.label, why: error.message || error}), "error");
        }
    }
    if(reply.removed.length && current.store) {
        print(t("lm deleted {files}; they are still in {where}.", {files: reply.removed.join(", "), where: current.store.label}), "info");
    }
    const changed = reply.changed.map(f => f.path);
    if(changed.length) {
        const files = changed.length > 8 ? t("{files} and {n} more", {files: changed.slice(0, 8).join(", "), n: changed.length - 8}) : changed.join(", ");
        print(t("Wrote {files} ({seconds} s)", {files, seconds: (reply.ms / 1000).toFixed(1)}), "info");
    }
    filesWindow.refresh();
    // Show what the command made.
    const gds = changed.find(p => /\.gds$/i.test(p)), dot = changed.filter(p => /\.dot$/i.test(p)), vcd = changed.find(p => /\.vcd$/i.test(p));
    if(gds) {
        layoutWindow.open(gds);
    } else {
        layoutWindow.refresh();
    }
    if(dot.length) {
        // The handshake's net, when there is one, is the interesting picture.
        graphWindow.open(dot.find(p => /wchb/.test(p)) || dot[0]);
    } else {
        graphWindow.refresh();
    }
    if(vcd) {
        wavesWindow.open(vcd);
    } else {
        wavesWindow.refresh();
    }
    updateStatus();
}

// ----- Projects

async function loadProject(name, files, store = null) {
    files = store ? files.filter(f => f.path) : stripCommonFolder(files.filter(f => f.path));
    name = name.replace(/\.(zip|tar|tgz|tar\.gz|wv|cog|cogw|prs)$/i, "").replace(/[^\w.-]+/g, "_") || "project";
    project = {name, files, store};
    document.title = `${name} · Loom`;
    print(files.length ? t("Opened {name}: {files}", {name, files: files.map(f => f.path).join(", ")}) : t("Opened {name}: no files yet", {name}), "info");
    if(!files.some(f => f.path === "lm.mod")) {
        print(t("This project has no lm.mod: lm mod init <name> makes one (lm build needs it to find the sources in src/)."), "info");
    }
    filesWindow.open();
    filesWindow.refresh();
    layoutWindow.refresh();
    layoutWindow.draw();
    graphWindow.refresh();
    wavesWindow.refresh();
    updateStatus();
    return true;
}

async function loadExample(name) {
    const example = EXAMPLES[name];
    statusEl.textContent = t("Loading {name}…", {name});
    const files = [];
    for(const file of example.files) {
        const url = here(`examples/${name}/${file}`);
        const response = await fetch(url);
        if(!response.ok) {
            throw new Error(t("Couldn't load the example {url}: HTTP {status}", {url, status: response.status}));
        }
        files.push({path: file, data: new Uint8Array(await response.arrayBuffer())});
    }
    await loadProject(name, files);
    for(const line of example.run || []) {
        await run(line);
    }
}

async function newProject() {
    const v = await ask({title: "New project", message: "An empty project with lm.mod and src/top.wv (lm mod init).",
        fields: [{name: "name", label: "Module name", value: "mychip"}], ok: "Create"});
    if(v && v.name.trim()) {
        const name = v.name.trim().replace(/[^\w]+/g, "_");
        await loadProject(name, []);
        await run(`mod init ${name}`);
        filesWindow.show("src/top.wv");
    }
}

let recent = [];

async function refreshRecent() {
    recent = await recentProjects();
}

async function openStore(store) {
    statusEl.textContent = t("Reading {where}…", {where: store.label});
    const files = await store.readAll();
    if(await loadProject(store.name, files, store)) {
        print(t("Working in {where}: what lm writes and your edits are saved there.", {where: store.label}), "info");
    }
    refreshRecent();
}

async function keepProject(store) {
    if(!project) {
        return;
    }
    for(const f of project.files) {
        await store.write(f.path, f.data);
    }
    project.store = store;
    const n = project.files.length;
    print(t(n === 1 ? "Saved 1 file to {where}; later changes go there too." : "Saved {n} files to {where}; later changes go there too.",
        {n, where: store.label}), "info");
    updateStatus();
    refreshRecent();
}

async function download() {
    if(!project) {
        return;
    }
    const files = project.files;
    saveBlob(project.name + ".tar.gz", new Blob([await writeTarGz(files.map(f => ({path: project.name + "/" + f.path, data: f.data})))],
        {type: "application/gzip"}));
    print(t(files.length === 1 ? "Saved 1 file to {name}" : "Saved {n} files to {name}", {n: files.length, name: project.name + ".tar.gz"}), "info");
}

async function attempt(work) {
    try {
        await work();
    } catch(error) {
        if(error && error.name === "AbortError") {
            return;
        }
        print(String(error.message || error), "error");
        updateStatus();
    }
}

const NEEDS_CHROMIUM = "Needs Chrome, Edge or another Chromium browser (the File System Access API)";

function projectMenu() {
    const items = [
        {label: "New project…", action: () => attempt(newProject)},
        {label: "Open files…", action: () => $("#pick-files").click()},
        {label: "Open folder (copy)…", action: () => $("#pick-folder").click()},
        {label: "Add files to project…", disabled: !project, title: "Copy files into the open project", action: () => $("#add-files").click()},
        "-",
        {label: "Work in a folder on disk…", disabled: !diskSupported, title: diskSupported ?
            "Open a folder; what lm writes and your edits are saved into it" : NEEDS_CHROMIUM,
        action: () => attempt(async () => openStore(await DiskStore.pick()))},
        {label: "Save project to a folder on disk…", disabled: !diskSupported || !project, title: diskSupported ?
            "Copy this project into a folder and keep working there" : NEEDS_CHROMIUM,
        action: () => attempt(async () => keepProject(await DiskStore.pick()))},
        {label: "Keep project in browser storage", disabled: !project || project.store instanceof BrowserStore,
            title: "Saves into this browser (private to this site) and keeps it there",
            action: () => attempt(async () => keepProject(await BrowserStore.create(project.name)))},
    ];
    if(recent.length) {
        items.push("-");
        for(const entry of recent.slice(0, 8)) {
            items.push({label: t(entry.kind === "disk" ? "Reopen {name} (folder)" : "Reopen {name} (browser storage)", {name: entry.name}),
                action: () => attempt(async () => openStore(await reopen(entry)))});
        }
        items.push({label: "Forget recent projects…", action: () => attempt(async () => {
            const stored = recent.filter(e => e.kind === "browser").map(e => e.name);
            const question = stored.length ? t("Forget the recent projects? This deletes {names} from browser storage. Folders on disk are not touched.",
                {names: stored.join(", ")}) : t("Forget the recent projects? Folders on disk are not touched.");
            if(window.confirm(question)) {
                for(const entry of recent) {
                    await forget(entry.id);
                }
                await refreshRecent();
            }
        })});
    }
    items.push("-",
        {label: "Build (lm build)", disabled: !project || session.busy, action: () => attempt(() => run("build"))},
        {label: "Draw the processes (lm show)", disabled: !project || session.busy, action: () => attempt(() => run("show"))},
        {label: "List the modules (lm mod show)", disabled: !project || session.busy, action: () => attempt(() => run("mod show"))},
        "-",
        {label: "Download project (.tar.gz)", disabled: !project, action: () => attempt(download)});
    return items;
}

// ----- Files window: view and edit the project's files

class FilesWindow {
    constructor() {
        this.fw = null;
        this.path = null;
    }

    isOpen() {
        return Boolean(this.fw);
    }

    open() {
        if(this.fw) {
            this.fw.raise();
            return;
        }
        this.fw = new FloatingWindow(desktop, {
            title: "Files", x: 12, y: 12, width: Math.min(560, desktop.clientWidth - 24),
            height: Math.min(340, desktop.clientHeight - 24), onClose: () => this.close(),
        });
        this.fw.body.innerHTML = '<div class="files-body"><ul class="files-list" role="listbox" data-i18n-aria-label="Project files"></ul>' +
            '<div class="files-edit"><div class="files-bar"><button type="button" data-act="save" data-i18n="Save" data-i18n-title="Write the file (Ctrl+S)"></button>' +
            '<button type="button" data-act="display" data-i18n="Show" data-i18n-title="Show it in the Layout, Graph or Waves window"></button>' +
            '<button type="button" data-act="new" data-i18n="New…"></button><button type="button" data-act="remove" data-i18n="Delete"></button>' +
            '<button type="button" data-act="download" data-i18n="Download"></button><span></span></div>' +
            '<textarea spellcheck="false" data-i18n-aria-label="File contents"></textarea></div></div>';
        applyStatic(this.fw.body);
        this.list = this.fw.body.querySelector(".files-list");
        paneResizer(this.list, {label: "Resize the file list", storageKey: "loom-files-list-width"});
        this.text = this.fw.body.querySelector("textarea");
        this.label = this.fw.body.querySelector(".files-bar span");
        this.openButton = this.fw.body.querySelector("[data-act=display]");
        this.list.addEventListener("click", e => {
            const li = e.target.closest("li");
            if(li) {
                this.show(li.dataset.path);
            }
        });
        this.fw.body.querySelector(".files-bar").addEventListener("click", e => {
            const act = e.target.closest("button")?.dataset.act;
            if(act) {
                attempt(() => this[act]());
            }
        });
        this.text.addEventListener("keydown", e => {
            if(e.key === "s" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                attempt(() => this.save());
            }
        });
        this.refresh();
    }

    close() {
        this.fw?.remove();
        this.fw = null;
    }

    refresh() {
        if(!this.fw || !project) {
            return;
        }
        // Sources first, then what lm built.
        const paths = project.files.map(f => f.path).sort((a, b) => (a.startsWith("build/") - b.startsWith("build/")) || a.localeCompare(b));
        this.list.textContent = "";
        for(const path of paths) {
            const li = document.createElement("li");
            li.dataset.path = path;
            li.textContent = path;
            li.setAttribute("role", "option");
            li.setAttribute("aria-selected", String(path === this.path));
            this.list.appendChild(li);
        }
        if(this.path && paths.includes(this.path)) {
            this.show(this.path, true);
        } else if(paths.length) {
            this.show(paths.find(p => SOURCES.test(p) && p.startsWith("src/")) || paths[0]);
        } else {
            this.path = null;
            this.text.value = "";
            this.label.textContent = "";
        }
    }

    show(path, keepEdits = false) {
        const file = project?.files.find(f => f.path === path);
        if(keepEdits && path === this.path && this.shownData === file?.data) {
            return;
        }
        this.path = path;
        this.shownData = file?.data;
        const data = file?.data;
        const binary = data && (/\.(gds|oas|gz|zip|png)$/i.test(path) || data.subarray(0, 512).includes(0));
        const big = data && data.length > 2e6;
        this.text.value = !data ? "" : binary ? t(/\.gds$/i.test(path) ? "({n} bytes of binary data: Show draws the layout)" : "({n} bytes of binary data)",
            {n: data.length}) : big ? t("({n} bytes: too big to show)", {n: data.length}) : decoder.decode(data);
        this.text.readOnly = Boolean(binary || big);
        this.label.textContent = path;
        this.openButton.hidden = !/\.(gds|dot|gv|vcd)$/i.test(path);
        for(const li of this.list.children) {
            li.setAttribute("aria-selected", String(li.dataset.path === path));
        }
    }

    async save() {
        if(!this.path || this.text.readOnly) {
            return;
        }
        const data = encoder.encode(this.text.value);
        await writeProjectFile(this.path, data);
        this.shownData = data;
        print(t("Wrote {path}", {path: this.path}), "info");
    }

    // The file in the window that draws it.
    display() {
        if(/\.gds$/i.test(this.path)) {
            layoutWindow.open(this.path);
        } else if(/\.(dot|gv)$/i.test(this.path)) {
            graphWindow.open(this.path);
        } else if(/\.vcd$/i.test(this.path)) {
            wavesWindow.open(this.path);
        }
    }

    async new() {
        const v = await ask({title: "New file", fields: [{name: "path", label: "File name", value: "src/process.wv"}], ok: "Create"});
        if(v && v.path) {
            const path = cleanPath(v.path);
            await writeProjectFile(path, new Uint8Array());
            this.refresh();
            this.show(path);
            this.text.focus();
        }
    }

    async remove() {
        const question = project?.store ? t("Delete {path} from the project? (It stays in {where}.)", {path: this.path, where: project.store.label}) :
            t("Delete {path} from the project?", {path: this.path});
        if(this.path && window.confirm(question)) {
            project.files = project.files.filter(f => f.path !== this.path);
            this.path = null;
            this.refresh();
        }
    }

    download() {
        const file = project?.files.find(f => f.path === this.path);
        if(file) {
            saveBlob(this.path.split("/").pop(), new Blob([file.data]));
        }
    }
}

async function writeProjectFile(path, data) {
    if(!project) {
        project = {name: "untitled", files: [], store: null};
    }
    const known = project.files.find(f => f.path === path);
    known ? (known.data = data) : project.files.push({path, data});
    if(project.store) {
        try {
            await project.store.write(path, data);
            project.syncError = null;
        } catch(error) {
            project.syncError = error;
            print(t("Couldn't save to {where}: {why}", {where: project.store.label, why: error.message || error}), "error");
        }
    }
    updateStatus();
}

const filesWindow = new FilesWindow();
const projectFiles = () => project?.files || [];
// Loom's technology file, for the layer names in the Layout window.
const techText = async () => (await fetch(here("src/tech/sky130/tech.py"))).text();
const libraryFiles = () => [...library].map(([path, data]) => ({path, data}));
const layoutWindow = new LayoutWindow({desktop, files: projectFiles, library: libraryFiles, techText, print});
const graphWindow = new GraphWindow({desktop, files: projectFiles, print, saveBlob});
const wavesWindow = new WavesWindow({desktop, files: projectFiles});

const toggle = w => (w.isOpen() ? w.close() : w.open());
const windowsMenu = () => [
    {label: "Files", checked: () => filesWindow.isOpen(), action: () => toggle(filesWindow)},
    {label: "Layout", checked: () => layoutWindow.isOpen(), action: () => toggle(layoutWindow)},
    {label: "Graph", checked: () => graphWindow.isOpen(), action: () => toggle(graphWindow)},
    {label: "Waves", checked: () => wavesWindow.isOpen(), action: () => toggle(wavesWindow)},
];

// ----- Opening files

async function filesFromInput(fileList) {
    const files = [];
    for(const file of fileList) {
        files.push({path: cleanPath(file.webkitRelativePath || file.name), data: new Uint8Array(await file.arrayBuffer())});
    }
    return files;
}

async function openFiles(fileList, folderName) {
    try {
        const list = Array.from(fileList);
        if(list.length === 1 && isArchive(list[0].name)) {
            statusEl.textContent = t("Reading {where}…", {where: list[0].name});
            await loadProject(list[0].name, await readArchive(list[0].name, new Uint8Array(await list[0].arrayBuffer())));
            return;
        }
        const files = await filesFromInput(list);
        const name = folderName || files[0]?.path.split("/")[0].replace(/\.\w+$/, "") || "project";
        await loadProject(name, files);
    } catch(error) {
        print(String(error.message || error), "error");
        updateStatus();
    }
}

async function addFiles(fileList) {
    if(!project) {
        return openFiles(fileList);
    }
    const files = await filesFromInput(Array.from(fileList));
    for(const f of files) {
        await writeProjectFile(f.path, f.data);
    }
    print(t("Added {files}", {files: files.map(f => f.path).join(", ")}), "info");
    filesWindow.refresh();
}

async function readEntry(entry, prefix) {
    if(entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        return [{path: cleanPath(prefix + file.name), data: new Uint8Array(await file.arrayBuffer())}];
    }
    const reader = entry.createReader(), files = [];
    for(;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if(!batch.length) {
            break;
        }
        for(const child of batch) {
            files.push(...await readEntry(child, prefix + entry.name + "/"));
        }
    }
    return files;
}

$("#pick-files").addEventListener("change", event => {
    openFiles(event.target.files);
    event.target.value = "";
});
$("#pick-folder").addEventListener("change", event => {
    const first = event.target.files[0];
    openFiles(event.target.files, first ? first.webkitRelativePath.split("/")[0] : null);
    event.target.value = "";
});
$("#add-files").addEventListener("change", event => {
    attempt(() => addFiles(event.target.files));
    event.target.value = "";
});
document.addEventListener("dragover", event => {
    if(event.dataTransfer?.types?.includes("Files")) {
        event.preventDefault();
        document.body.classList.add("dragging");
    }
});
document.addEventListener("dragleave", event => {
    if(!event.relatedTarget) {
        document.body.classList.remove("dragging");
    }
});
document.addEventListener("drop", async event => {
    if(!event.dataTransfer?.types?.includes("Files")) {
        return;
    }
    event.preventDefault();
    document.body.classList.remove("dragging");
    const entries = Array.from(event.dataTransfer.items || []).filter(i => i.kind === "file")
        .map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if(entries.length === 1 && entries[0].isDirectory) {
        await attempt(async () => loadProject(entries[0].name, await readEntry(entries[0], "")));
        return;
    }
    await openFiles(event.dataTransfer.files);
});

// ----- Command line

const history = [];
let historyIndex = 0;

commandInput.addEventListener("keydown", event => {
    if(event.key === "Enter") {
        const line = commandInput.value.trim();
        commandInput.value = "";
        if(line || session.waiting) {
            if(line && history[history.length - 1] !== line) {
                history.push(line);
            }
            historyIndex = history.length;
            if(session.busy && !session.waiting) {
                print(t("lm is still running; wait for it, or Stop it."), "info");
                return;
            }
            run(line);
        }
    } else if(event.key === "ArrowUp" && historyIndex > 0) {
        commandInput.value = history[--historyIndex];
        event.preventDefault();
    } else if(event.key === "ArrowDown") {
        historyIndex = Math.min(history.length, historyIndex + 1);
        commandInput.value = history[historyIndex] || "";
        event.preventDefault();
    }
});

$("#stop").addEventListener("click", () => {
    const what = session.current;
    if(session.stop()) {
        print(t("Stopped lm {command}.", {command: what}), "info");
    }
    home();
});
$("#console-toggle").addEventListener("click", () => {
    const collapsed = $("#console").classList.toggle("collapsed");
    $("#console-toggle").setAttribute("aria-expanded", String(!collapsed));
});

// ----- Help

function showHelp(show) {
    $("#help").hidden = !show;
    $("#help-toggle").setAttribute("aria-expanded", String(show));
}
$("#help-toggle").addEventListener("click", () => showHelp($("#help").hidden));
document.addEventListener("pointerdown", event => {
    if(!$("#help").hidden && !event.target.closest("#help, #help-toggle")) {
        showHelp(false);
    }
}, true);

// ----- Keyboard focus
//
// The command line is home: controls used with the mouse give the keyboard back to it;
// controls used with the keyboard keep focus.  Escape first closes the help or a menu.

function home() {
    commandInput.focus({preventScroll: true});
}

document.addEventListener("keydown", event => {
    if(event.key !== "Escape" || event.defaultPrevented) {
        return;
    }
    if(!$("#help").hidden) {
        event.preventDefault();
        const fromKeyboard = document.activeElement?.closest?.("#help, #help-toggle");
        showHelp(false);
        fromKeyboard ? $("#help-toggle").focus() : home();
    } else if(document.querySelector(".mb-menu")) {
        closeMenus();
    }
});
document.addEventListener("click", event => {
    const control = event.target.closest("button, input[type=checkbox], label, #sponsor");
    if(event.detail === 0 || !control || control.closest("dialog, .mb-menu, .mb-bar, #help, .files-bar, .command-row, .lay-bar, .lay-layers")) {
        return;
    }
    setTimeout(() => {
        const active = document.activeElement;
        if(active === document.body || active === control || control.contains(active)) {
            home();
        }
    }, 0);
});
setHomeFocus(home);

// ----- Start

const SOURCE = "https://github.com/NickOveracker/loom/tree/wasm";
$("#top-menus").appendChild(menuBar([
    ["Project", projectMenu],
    ["Examples", Object.entries(EXAMPLES).map(([name, example]) => ({label: example.label, action: () => attempt(() => loadExample(name))}))],
    ["Windows", windowsMenu],
    ["About", [
        {label: "Loom (Broccoli)", href: "https://broccolimicro.io/"},
        {label: "Loom's documentation", href: "https://broccolimicro.github.io/loom"},
        {label: "Loom upstream source", href: "https://github.com/broccolimicro/loom"},
        "-",
        {label: "Sponsor Broccoli, Loom's makers, on GitHub", href: "https://github.com/sponsors/broccolimicro"},
        {label: "Support this unofficial fork on Ko-fi", href: "https://ko-fi.com/twentynine"},
        "-",
        {label: "Loom license (GPL 3)", href: "https://github.com/NickOveracker/loom/blob/wasm/src/COPYRIGHT"},
        {label: "Web app license (GPL 3 or later)", href: "https://github.com/NickOveracker/loom/blob/wasm/licenses/GPL-3.0.txt"},
        {label: "gdstk license (Boost)", href: "https://github.com/heitzmann/gdstk/blob/main/LICENSE"},
        {label: "Qhull license", href: "https://github.com/NickOveracker/loom/blob/wasm/licenses/qhull-COPYING.txt"},
        {label: "OpenCL headers license (Apache 2.0)", href: "https://github.com/NickOveracker/loom/blob/wasm/licenses/OpenCL-headers-LICENSE"},
        {label: "Graphviz license (EPL 2.0), drawing graphs", href: "https://github.com/NickOveracker/loom/blob/wasm/vendor/viz/LICENSE-graphviz"},
        {label: "Viz.js license (MIT)", href: "https://github.com/NickOveracker/loom/blob/wasm/vendor/viz/LICENSE-viz-js"},
        {label: "Emscripten runtime license (MIT)", href: "https://github.com/NickOveracker/loom/blob/wasm/licenses/emscripten-LICENSE"},
        "-",
        {label: "This web app's source", href: SOURCE},
    ]],
], "Page menu", {onDone: home}));

// The notices the GNU General Public License (version 3, section 5d) asks an interactive
// program to show: copyright (Loom's own, from lm version), no warranty, the licence and where
// it is.
async function announce() {
    let version = "";
    try {
        const response = await fetch(here("src/VERSION"));
        version = response.ok ? ` ${(await response.text()).trim()}` : "";
    } catch(error) {
        // Without the version
    }
    print(t("Loom{version}, Copyright (C) 2024 Broccoli, LLC; changed for this WebAssembly build in 2026 (the changes are " +
        "listed in the source, About > This web app's source).", {version}), "info");
    print(t("Loom comes with ABSOLUTELY NO WARRANTY. It is free software: you may redistribute it under the terms of the " +
        "GNU General Public License, version 3; About > Loom license shows a copy."), "info");
}

// The page's static text, the language button, and what to redo when the language changes.
applyStatic();
$("#help-toggle").before(languageButton());
const dropText = () => (desktop.dataset.drop = t("Drop a Loom project folder, source files (.wv, .cogw, .prs…), or a .zip / .tar.gz to open it"));
dropText();
onLanguageChange(() => {
    dropText();
    updateStatus();
    filesWindow.refresh();
    if(filesWindow.text?.readOnly) {
        filesWindow.show(filesWindow.path);
    }
    layoutWindow.refresh();
    layoutWindow.draw();
    graphWindow.refresh();
    wavesWindow.refresh();
});

async function start() {
    refreshRecent();
    await announce();
    const name = new URLSearchParams(location.search).get("example");
    await loadExample(EXAMPLES[name] ? name : DEFAULT_EXAMPLE);
    home();
}

start().catch(error => print(String(error.message || error), "error"));

// For tests and the browser console.
window.loomApp = {run, session, loadProject, loadExample, keepProject, openStore, BrowserStore, recentProjects,
    filesWindow, layoutWindow, graphWindow, wavesWindow,
    library,
    get project() {
        return project;
    }};
