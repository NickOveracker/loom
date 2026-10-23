// SPDX-License-Identifier: GPL-3.0-or-later
// gvdot::render for the web build, in place of src/bin/ckt/src/format/dot.cpp: there is no
// Graphviz in the module, so lm show writes the graph as <name>.dot, whatever format was
// asked for, and the page draws it.
#include "format/dot.h"

#include <cstdio>

using namespace std;

namespace gvdot {

void render(string filename, string content) {
	string format = "png";
	size_t pos = filename.find_last_of(".");
	if (pos != string::npos) {
		format = filename.substr(pos+1);
		filename = filename.substr(0, pos);
	}
	FILE *file = fopen((filename + ".dot").c_str(), "w");
	if (file == nullptr) {
		printf("unable to write %s.dot\n", filename.c_str());
		return;
	}
	fprintf(file, "%s\n", content.c_str());
	fclose(file);
}

}
