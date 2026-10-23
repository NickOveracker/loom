# Loom for WebAssembly

An unofficial fork of [Loom](https://github.com/broccolimicro/loom), Broccoli's circuit compiler (`lm`), compiled to
WebAssembly with [Emscripten](https://emscripten.org), and a web app around it. Loom compiles Weaver, its language for
circuits, to Verilog (functions) or to production rules, a sized transistor netlist and a SkyWater 130 nm layout
(protocols given wire by wire); it also simulates, and draws processes as Petri nets. Loom is pre-alpha: its own
README lists what works.

The app is what this folder holds. Loom's own source, with its README, documentation, examples and native build, is in
`src/`, with its libraries as submodules under `src/lib/` and `src/bin/`.

This fork is not made or endorsed by Broccoli. To support Loom itself, see
[Broccoli's GitHub Sponsors page](https://github.com/sponsors/broccolimicro).

## Building

```sh
git submodule update --init --recursive
source /path/to/emsdk/emsdk_env.sh
./build.sh                  # loom.js and loom.wasm, next to the app
./build.sh native           # build-native/lm: the same sources as a Linux program, to compare with
python3 -m http.server      # from the repository root; then open /
```

`build.sh` compiles the sources that Loom's Makefiles would (its 35 libraries, gdstk and `bin/ckt`, which is `lm`)
in one place, fetching qhull (for gdstk) and the Khronos OpenCL headers into `build-web/` (or `build-native/`) the
first time. The result, `loom.js` (a module factory, `createLoom`) and `loom.wasm` (about 8 MB, with Loom's technology
files embedded at `/usr/local/share/tech`), is committed so that the app works on GitHub Pages. Browsers don't start
workers from `file://` pages, so serve the folder over HTTP.

### What the browser lacks, and what stands in for it

| Native Loom uses | The web build uses |
| --- | --- |
| An embedded CPython, loaded at run time, to run the technology file (`tech/sky130/tech.py`), which calls a `loom` module to define layers, rules and devices. | `web/techscript.cpp`, in place of `src/lib/phy/phy/Script.cpp`: a reader for the plain Python that technology files are written in (assignments, calls, lists, tuples, arithmetic, `if` blocks), making the same calls on the technology as Script.cpp's bindings. Anything else stops with the file and line. |
| OpenCL, for the cell placer (`src/lib/sch/sch/Placer.cpp`); without an OpenCL device, Loom exits when it places cells. | `web/opencl.c`: the 26 OpenCL calls the placer makes, for one CPU "device". Placement runs one kernel, `globalStep` (spreading cells along a Hilbert curve), written here in C from `src/lib/sch/cl/placer.cpp`; legalization was already on the CPU. The native build uses it too, unless `NATIVE_OPENCL=system`, so that both place cells alike. |
| Graphviz (linked, or the `dot` program), to draw `lm show`'s graphs. | `web/dot.cpp`, in place of `src/bin/ckt/src/format/dot.cpp`: `lm show` writes the graph as `.dot`, and the page draws it with Graphviz in a worker of its own (`viz-worker.js`, [Viz.js](https://github.com/mdaines/viz-js) 3.31.0 with Graphviz 16.1.0, in `vendor/viz/`). |
| A terminal: the simulators (`lm sim`) read commands with `fgets(stdin)`. | `web/stdin.c` and `web/stdin.h` (included before `sim.cpp` only): `fgets` on stdin waits, through Asyncify, for the next line from the page's console, and passes the prompt (`(prsim)`, which has no newline) to the page. |

Each `lm` command runs in a fresh instance of the module, as each is a process of its own in a terminal; the compiled
module is reused. `lm build` puts the cells it lays out into the technology's cell library (`sky130/cells/`, outside the
project); the page keeps that library and passes it back with each command.

One difference from a native build: Loom names generated cells from a `size_t` hash in base 32, which is 32 bits in
WebAssembly, so the web build's names are shorter (`cell_nfyb` where Linux has `cell_dbxhzt4g`). The production rules
and Verilog of the examples are otherwise the same as the native build's.

## The web app

| File | Role |
| --- | --- |
| `index.html`, `app.js` | The page: console, Project / Examples / Windows / About menus, projects, help. |
| `worker.js`, `session.js` | `lm` in a Web Worker, one command at a time, with the project's files in `/work`. **Stop** ends a command (or a simulation) by starting a fresh worker; the project and the cell library are the page's, so nothing else is lost. |
| `layout.js` | The Layout window: reads GDSII (boundaries, paths, boxes, cell references and arrays, text), fills `project.gds`'s cells from the cell library, and draws them by layer with the technology file's layer names; pan, zoom, pinch, hide layers. |
| `graph.js`, `viz-worker.js` | The Graph window: `lm show`'s Petri nets, drawn as SVG (shown as an image, so nothing in a graph runs in the page). |
| `waves.js` | The Waves window: the `.vcd` files the simulators write when you quit them. |
| `menu.js`, `dialog.js`, `floating-window.js`, `archive.js`, `storage.js`, `handoff.js` | Menus, dialogs, windows, .zip/.tar.gz, project storage, and passing projects between apps (shared with the Magic, IRSIM and netgen web apps). |
| `examples/` | Loom's README tutorial, and two of Loom's own examples (`src/examples/cog/`), each with a README. |
| `build.sh`, `web/` | The WebAssembly build. |
| `licenses/`, `vendor/viz/` | Licences of what the module and the page contain. |

* **Console.** `lm` commands (the `lm` is optional): `build`, `show`, `sim <file>`, `mod init <name>`, `mod show`,
  `help`. While a simulator runs, the console takes its commands. `clear` clears the console.
* **Projects.** New project (`lm mod init`), open files, a folder, or one .zip/.tar/.tar.gz (or drop them on the page).
  Projects can be kept in a folder on disk (Chromium browsers) or in the browser's storage; what `lm` writes and edits
  in the Files window go there.

## Source changes

Loom's own code is changed in two places, both bugs that also affect the native build; each changed file carries a
dated notice. The changed libraries are forks of their own, on branch `wasm`, and `.gitmodules` points to them:

* `src/lib/interpret_wv` ([fork](https://github.com/NickOveracker/interpret_wv)), `export.cpp`: `lm.mod` got the
  technology's absolute path, which reading it back made relative to the project (`../../usr/local/share/tech/sky130`).
  The `/` then ended up in generated cell names, and reading `build/src/module.spi` failed ("stray '/'"), so `lm sim`
  on a built design stopped. A technology from the technology folder is now written by name (`tech "sky130"`), as
  `lm mod init` sets it.
* `src/bin/ckt` ([fork](https://github.com/NickOveracker/ckt)), `src/format/cell.cpp`: a cell that `lm build` laid out
  was kept only with `-p` (progress), so without it every cell was laid out, dropped, and reported as "unable to build
  layout". Progress now only decides what is printed.

A third, in how the native build is compiled rather than in the source: without Graphviz, `format/dot.cpp` calls
`error()` and `warning()` without including their header; `build.sh native` includes it on the command line.

Not changed, but found while porting (these behave the same natively):

* "internal failure: decl not hashed" (`weaver/instance.cpp`) after most builds; the builds still complete.
* The simulators loop forever at the end of input when it is piped in; the web app never ends the input.
* `lm help show` lists `-o`, which `lm show` doesn't take: graphs go to `build/dbg/`.
* Loom's README tutorial begins `top.wv` with `import "buffer"`, which the current version doesn't need and doesn't
  find; the app's tutorial leaves it out. `examples/README.md` builds `.hse` files, which the current version no
  longer reads.

## Licences

Loom is free software under the GNU General Public License, version 3 (`src/COPYRIGHT`), Copyright (C) 2024
Broccoli, LLC. This fork's new code (the web app, `build.sh` and `web/`) is under the GPL, version 3 or (at your option)
any later version (`licenses/GPL-3.0.txt`). The module also contains gdstk (Boost Software License,
`src/lib/gdstk/LICENSE`), qhull (`licenses/qhull-COPYING.txt`), code from the Khronos OpenCL C++ headers (Apache 2.0,
`licenses/OpenCL-headers-LICENSE`) and the Emscripten runtime (MIT, `licenses/emscripten-LICENSE`). Graphviz (Eclipse
Public License 2.0), with Viz.js (MIT) and Expat (MIT), is a separate program the page runs in its own worker to draw
graphs, as the native `lm` runs Graphviz; its licences are in `vendor/viz/`. The icon is the one Loom's own web front end
uses (`src/bin/studio/favicon.ico`).

The page shows Loom's copyright, the absence of warranty and where the licence is when it starts.
