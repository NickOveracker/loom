#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Build Loom's lm, as WebAssembly for the web app (the default) or natively, to compare with.
#
#   ./build.sh              loom.js and loom.wasm at the top of the repository (needs emcc on PATH)
#   ./build.sh native       build-native/lm, an ordinary Linux build of the same sources
#
# Loom's own Makefiles build each library, then link bin/ckt.  This script compiles the same
# sources in one place, so that the WebAssembly build can leave out what a browser can't run:
#   - phy/Script.cpp, which runs the technology file (tech.py) in an embedded CPython; the web
#     build reads the same file with web/techscript.cpp, which understands the plain Python
#     that technology files are written in (assignments and calls);
#   - OpenCL, which sch's placer uses for one kernel: web/opencl.c runs it on the CPU (the native
#     build uses it too, unless NATIVE_OPENCL=system, so that the two place cells alike);
#   - Graphviz: lm show writes .dot files, and the page draws them.
# lm's simulators read their commands from stdin; web/stdin.c gives them the page's console,
# through Asyncify, so a simulation waits for the next command as it does in a terminal.
#
# Dependencies fetched into build-web/ (or build-native/): qhull (for gdstk), and the OpenCL
# headers, which sch's headers include even where OpenCL isn't used.
set -euo pipefail
cd "$(dirname "$0")"
TOP=$PWD
MODE=${1:-web}
OUT=$TOP/build-$MODE
OPT=${OPT:--O2}
JOBS=${JOBS:-$(nproc)}
mkdir -p "$OUT/deps"

fetch() {    # fetch <dir> <repository> <tag>
    [ -d "$OUT/deps/$1" ] || git -c advice.detachedHead=false clone -q --depth 1 --branch "$3" "$2" "$OUT/deps/$1"
}
fetch qhull https://github.com/qhull/qhull.git v8.0.2
fetch OpenCL-Headers https://github.com/KhronosGroup/OpenCL-Headers.git v2024.10.24
fetch OpenCL-CLHPP https://github.com/KhronosGroup/OpenCL-CLHPP.git v2024.10.24

if [ "$MODE" = web ]; then
    CC=emcc; CXX=em++; AR=emar
    PLATFORM="-D LINUX -D LOOM_WEB=1 -sUSE_ZLIB=1 -fexceptions"
else
    CC=${NATIVE_CC:-gcc}; CXX=${NATIVE_CXX:-g++}; AR=ar
    PLATFORM="-D LINUX -D AMD64 $(python3-config --includes)"
fi
CXXFLAGS="-std=c++20 $OPT -g0 -fmessage-length=0 -w $PLATFORM \
    -D CL_HPP_MINIMUM_OPENCL_VERSION=120 -D CL_HPP_TARGET_OPENCL_VERSION=120 -D CL_HPP_ENABLE_EXCEPTIONS"
CFLAGS="$OPT -g0 -w $PLATFORM"

# bin/ckt's libraries, in its link order.
LIBS="interpret_sch interpret_prs interpret_hse interpret_chp interpret_wv weaver chp interpret_gc gc interpret_flow
    interpret_verilog interpret_arithmetic interpret_boolean hse prs sch interpret_phy flow verilog phy petri arithmetic
    boolean parse_verilog parse_prs parse_cog parse_gc parse_chp parse_astg parse_spice parse_dot parse_expression
    parse_ucs parse common"
INCLUDES="-I$TOP/src/bin/ckt/src -I$TOP/src/lib/gdstk/include -I$TOP/src/lib/gdstk/external -I$OUT/deps/qhull/src
    -I$OUT/deps/OpenCL-Headers -I$OUT/deps/OpenCL-CLHPP/include"
for lib in $LIBS; do
    INCLUDES="$INCLUDES -I$TOP/src/lib/$lib"
done

# Every source file, with the object it compiles to.
sources() {
    find "$TOP/src/lib/gdstk/src" "$TOP/src/lib/gdstk/external/clipper" -name '*.cpp'
    find "$OUT/deps/qhull/src/libqhull_r" -name '*.c' ! -name 'unix_r.c' ! -name 'qconvex_r.c' ! -name 'testqset_r.c' \
        ! -name 'user_eg*' ! -name 'rbox_r.c' ! -name 'qset_r.c.bak'
    for lib in $LIBS; do
        find "$TOP/src/lib/$lib/$lib" -name '*.cpp'
    done
    find "$TOP/src/bin/ckt/src" -name '*.cpp'
    [ "${NATIVE_OPENCL:-}" = system ] || echo "$TOP/web/opencl.c"
    if [ "$MODE" = web ]; then
        echo "$TOP/web/techscript.cpp"
        echo "$TOP/web/dot.cpp"
        echo "$TOP/web/stdin.c"
    fi
}
excluded() {
    case "$1" in
        */phy/phy/Script.cpp | */bin/ckt/src/format/dot.cpp) [ "$MODE" = web ] ;;
        *) return 1 ;;
    esac
}

# sch's OpenCL kernels, as a string (as sch's Makefile makes sch/Kernel.h).
mkdir -p "$OUT/gen"
{
    printf '#pragma once\n\nnamespace sch {\n\nconst string placer_cpp_string = '
    sed 's/\\/\\\\/g;s/"/\\"/g;s/^/"/g;s/$/\\n"/g' src/lib/sch/cl/placer.cpp
    printf ';\n}\n'
} > "$OUT/gen/Kernel.h.new"
cmp -s "$OUT/gen/Kernel.h.new" "$OUT/gen/Kernel.h" || mv "$OUT/gen/Kernel.h.new" "$OUT/gen/Kernel.h"
INCLUDES="$INCLUDES -I$OUT/gen"

echo "const char *version = \"v$(cat src/VERSION)-web\";" > "$OUT/version.h"
OBJECTS=()
compile() {    # compile <source> <object>
    local src=$1 obj=$2
    mkdir -p "$(dirname "$obj")"
    if [ ! -f "$obj" ] || [ "$src" -nt "$obj" ]; then
        case "$src" in
            *.c) $CC $CFLAGS $INCLUDES -c "$src" -o "$obj" ;;
            # The simulators' fgets(stdin) goes to the page's console (web/stdin.h).
            */bin/ckt/src/sim.cpp) $CXX $CXXFLAGS -I"$OUT" $INCLUDES ${STDIN_HOOK:-} -c "$src" -o "$obj" ;;
            # Without Graphviz, dot.cpp uses error() and warning() without including their header.
            */bin/ckt/src/format/dot.cpp) $CXX $CXXFLAGS -I"$OUT" $INCLUDES -include common/message.h -c "$src" -o "$obj" ;;
            *) $CXX $CXXFLAGS -I"$OUT" $INCLUDES -c "$src" -o "$obj" ;;
        esac
    fi
}
[ "$MODE" = web ] && STDIN_HOOK="-include $TOP/web/stdin.h"
export -f compile
export CC CXX CFLAGS CXXFLAGS INCLUDES OUT STDIN_HOOK

LIST=$OUT/sources.txt
: > "$LIST"
while read -r src; do
    excluded "$src" && continue
    rel=${src#"$TOP"/}
    rel=${rel#build-$MODE/}
    obj="$OUT/obj/${rel%.*}.o"
    echo "$src $obj" >> "$LIST"
    OBJECTS+=("$obj")
done < <(sources)
# version.h is generated, so rebuild main.cpp's object when it changes.
xargs -P "$JOBS" -L 1 bash -c 'compile "$0" "$1"' < "$LIST"

if [ "$MODE" = web ]; then
    $CXX $OPT "${OBJECTS[@]}" -o "$TOP/loom.js" \
        -sUSE_ZLIB=1 -sMODULARIZE=1 -sEXPORT_NAME=createLoom -sENVIRONMENT=worker,node \
        -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8MB -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
        -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS,stringToUTF8,UTF8ArrayToString -sASYNCIFY=1 \
        -sASYNCIFY_IMPORTS=loom_web_read_line -sASYNCIFY_STACK_SIZE=65536 -fexceptions \
        --embed-file "$TOP/src/tech@/usr/local/share/tech"
    ls -l "$TOP/loom.js" "$TOP/loom.wasm"
else
    $CXX $OPT "${OBJECTS[@]}" -o "$OUT/lm" -lz -ldl $([ "${NATIVE_OPENCL:-}" = system ] && echo -lOpenCL)
    ls -l "$OUT/lm"
fi
