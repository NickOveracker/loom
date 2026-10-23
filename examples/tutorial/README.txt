Loom's tutorial, from the README of Loom (https://github.com/broccolimicro/loom, v0.16.1),
Copyright (C) 2024 Broccoli, LLC, under the GNU General Public License, version 3.

  src/top.wv     two functions, add and split, which lm build compiles to Verilog
  src/buffer.wv  a buffer, and wchb1b, a weak-condition half buffer: the buffer's
                 handshake given wire by wire, which lm build compiles to production
                 rules, a transistor netlist and a layout (build/src/project.gds)

One change from the README: its top.wv begins with import "buffer", which the current
Loom doesn't need (every file in src/ belongs to the module) and doesn't find.

Try: build, show, then sim build/src/<the .prs file> (help lists the simulator's commands).
