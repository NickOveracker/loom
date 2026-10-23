// SPDX-License-Identifier: GPL-3.0-or-later
// phy::loadTech for the web build, in place of src/lib/phy/phy/Script.cpp.
//
// Loom's technology files (tech/<node>/tech.py) are Python scripts that call the functions of
// a "loom" module (paint, width, spacing, via, nmos...) which Script.cpp provides to an
// embedded CPython.  A browser has no CPython, but the files are plain lists of assignments
// and calls, so this reads that subset of Python directly and makes the same calls on the
// Tech as Script.cpp's bindings do:
//
//   statements   name = expr, expr, from/import lines (ignored), comments, blank lines;
//                if/elif/else blocks on a constant condition, by indentation
//   expressions  numbers, strings, True/False/None, names, (tuples), [lists], calls with
//                positional and keyword arguments, unary -, not, + - * /, ==, !=, and, or
//
// Anything else stops with the file and line, so that a technology file that needs real
// Python says so instead of loading wrongly.

#include <phy/Script.h>
#include <phy/Tech.h>

#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <limits>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace std;

namespace phy {

namespace {

struct Value;
using ValueList = vector<Value>;

struct Value {
	enum Kind { NONE, BOOL, INT, FLOAT, STR, TUPLE, LIST } kind = NONE;
	long i = 0;
	double f = 0.0;
	string s;
	shared_ptr<ValueList> items;

	static Value none() { return Value(); }
	static Value boolean(bool b) { Value v; v.kind = BOOL; v.i = b; return v; }
	static Value integer(long n) { Value v; v.kind = INT; v.i = n; return v; }
	static Value real(double d) { Value v; v.kind = FLOAT; v.f = d; return v; }
	static Value str(string text) { Value v; v.kind = STR; v.s = text; return v; }
	static Value seq(Kind kind, ValueList list) { Value v; v.kind = kind; v.items = make_shared<ValueList>(list); return v; }

	bool isNumber() const { return kind == INT or kind == FLOAT or kind == BOOL; }
	double number() const { return kind == FLOAT ? f : (double)i; }
	bool truth() const {
		switch (kind) {
		case NONE: return false;
		case BOOL: case INT: return i != 0;
		case FLOAT: return f != 0.0;
		case STR: return not s.empty();
		default: return not items->empty();
		}
	}
};

struct ScriptError : runtime_error {
	using runtime_error::runtime_error;
};

// ----- Tokens

struct Token {
	enum Kind { END, NAME, NUMBER, STRING, OP } kind;
	string text;
};

class Lexer {
public:
	Lexer(const string &line) : line(line) {}

	Token next() {
		while (pos < line.size() and isspace((unsigned char)line[pos])) pos++;
		if (pos >= line.size() or line[pos] == '#') return {Token::END, ""};
		char c = line[pos];
		if (isalpha((unsigned char)c) or c == '_') {
			size_t start = pos;
			while (pos < line.size() and (isalnum((unsigned char)line[pos]) or line[pos] == '_' or line[pos] == '.')) pos++;
			return {Token::NAME, line.substr(start, pos - start)};
		}
		if (isdigit((unsigned char)c) or (c == '.' and pos + 1 < line.size() and isdigit((unsigned char)line[pos + 1]))) {
			size_t start = pos;
			while (pos < line.size() and (isalnum((unsigned char)line[pos]) or line[pos] == '.' or
				((line[pos] == '-' or line[pos] == '+') and (line[pos - 1] == 'e' or line[pos - 1] == 'E')))) pos++;
			return {Token::NUMBER, line.substr(start, pos - start)};
		}
		if (c == '"' or c == '\'') {
			string text;
			pos++;
			while (pos < line.size() and line[pos] != c) {
				if (line[pos] == '\\' and pos + 1 < line.size()) pos++;
				text += line[pos++];
			}
			if (pos >= line.size()) throw ScriptError("unterminated string");
			pos++;
			return {Token::STRING, text};
		}
		static const char *twoChar[] = {"==", "!=", "<=", ">=", "**", "//"};
		for (const char *op : twoChar) {
			if (line.compare(pos, 2, op) == 0) {
				pos += 2;
				return {Token::OP, op};
			}
		}
		pos++;
		return {Token::OP, string(1, c)};
	}

private:
	string line;
	size_t pos = 0;
};

// ----- The technology functions, as Script.cpp's bindings define them

Tech *tech = nullptr;

struct Args {
	string fn;
	ValueList pos;
	map<string, Value> kw;

	// The argument at position index or with keyword name; nullptr if neither was given.
	const Value *get(size_t index, const string &name) const {
		if (index < pos.size()) return &pos[index];
		auto it = kw.find(name);
		return it == kw.end() ? nullptr : &it->second;
	}
	const Value &need(size_t index, const string &name) const {
		const Value *v = get(index, name);
		if (v == nullptr) throw ScriptError(fn + "() needs the argument " + name);
		return *v;
	}
	long integer(size_t index, const string &name, long otherwise, bool required = false) const {
		const Value *v = required ? &need(index, name) : get(index, name);
		if (v == nullptr) return otherwise;
		if (v->kind != Value::INT and v->kind != Value::BOOL) throw ScriptError(fn + "(): " + name + " must be an integer");
		return v->i;
	}
	double real(size_t index, const string &name, double otherwise, bool required = false) const {
		const Value *v = required ? &need(index, name) : get(index, name);
		if (v == nullptr) return otherwise;
		if (not v->isNumber()) throw ScriptError(fn + "(): " + name + " must be a number");
		return v->number();
	}
	string text(size_t index, const string &name) const {
		const Value &v = need(index, name);
		if (v.kind != Value::STR) throw ScriptError(fn + "(): " + name + " must be a string");
		return v.s;
	}
	Level level(size_t index, const string &name, bool required = true) const {
		const Value *v = required ? &need(index, name) : get(index, name);
		if (v == nullptr) return Level();
		if (v->kind != Value::TUPLE or v->items->size() != 2 or (*v->items)[0].kind != Value::INT or (*v->items)[1].kind != Value::INT)
			throw ScriptError(fn + "(): " + name + " must be a level (a tuple of type and index)");
		return Level((*v->items)[0].i, (*v->items)[1].i);
	}
	vector<int> ints(size_t index, const string &name) const {
		vector<int> out;
		const Value *v = get(index, name);
		if (v == nullptr) return out;
		if (v->kind != Value::LIST) throw ScriptError(fn + "(): " + name + " must be a list");
		for (const Value &item : *v->items) {
			if (item.kind != Value::INT) throw ScriptError(fn + "(): " + name + " must hold integers");
			out.push_back(item.i);
		}
		return out;
	}
	vector<pair<int, int>> bins(size_t index, const string &name) const {
		vector<pair<int, int>> out;
		const Value *v = get(index, name);
		if (v == nullptr) return out;
		if (v->kind != Value::LIST) throw ScriptError(fn + "(): " + name + " must be a list");
		for (const Value &item : *v->items) {
			if (item.kind != Value::TUPLE or item.items->size() != 2 or (*item.items)[0].kind != Value::INT or (*item.items)[1].kind != Value::INT)
				throw ScriptError(fn + "(): bins must be (min, max) pairs of integers");
			out.push_back({(int)(*item.items)[0].i, (int)(*item.items)[1].i});
		}
		return out;
	}
};

Value levelValue(int type, int idx) {
	return Value::seq(Value::TUPLE, {Value::integer(type), Value::integer(idx)});
}

Value call(const Args &a) {
	const string &fn = a.fn;
	if (fn == "dbunit") {
		tech->dbunit = a.real(0, "value", 0, true);
		return Value::real(tech->dbunit);
	} else if (fn == "scale") {
		tech->scale = a.real(0, "value", 0, true);
		return Value::real(tech->scale);
	} else if (fn == "paint") {
		int result = (int)tech->paint.size();
		tech->paint.push_back(Paint(a.text(0, "name"), a.integer(1, "major", -1, true), a.integer(2, "minor", -1, true)));
		return Value::integer(result);
	} else if (fn == "width") {
		int layer = a.integer(0, "layer", -1, true);
		tech->setWidth(layer, a.integer(1, "width", -1, true));
		return Value::integer(layer);
	} else if (fn == "fill") {
		int layer = a.integer(0, "layer", -1, true);
		if (layer < 0 or layer >= (int)tech->paint.size()) throw ScriptError("fill(): no such paint layer");
		tech->paint[layer].fill = true;
		return Value::integer(layer);
	} else if (fn == "nmos" or fn == "pmos") {
		tech->models.push_back(Model(fn == "nmos" ? Model::NMOS : Model::PMOS, a.text(0, "variant"), a.text(1, "name"),
			a.level(2, "diff"), a.bins(3, "bins")));
		return Value::none();
	} else if (fn == "dielec") {
		tech->dielec.push_back(Dielectric(a.level(0, "down"), a.level(1, "up"), (float)a.real(2, "thick", 0, true),
			(float)a.real(3, "permit", 0)));
		return Value::none();
	} else if (fn == "subst") {
		int result = (int)tech->subst.size();
		tech->subst.push_back(Substrate(a.integer(0, "draw", -1, true), a.integer(1, "label", -1), a.integer(2, "pin", -1), -1,
			a.level(5, "well", false), (float)a.real(6, "thick", 0), (float)a.real(7, "resist", 0)));
		tech->subst.back().mask = a.ints(3, "mask");
		tech->subst.back().excl = a.ints(4, "excl");
		return levelValue(Level::SUBST, result);
	} else if (fn == "well") {
		int result = (int)tech->subst.size();
		tech->subst.push_back(Substrate(a.integer(0, "draw", -1, true), a.integer(1, "label", -1), a.integer(2, "pin", -1),
			a.integer(3, "tap", -1), Level(), (float)a.real(6, "thick", 0), (float)a.real(7, "resist", 0)));
		tech->subst.back().mask = a.ints(4, "mask");
		tech->subst.back().excl = a.ints(5, "excl");
		return levelValue(Level::SUBST, result);
	} else if (fn == "via") {
		int result = (int)tech->vias.size();
		tech->vias.push_back(Via(a.level(0, "down"), a.level(1, "up"), a.integer(2, "draw", -1, true), a.integer(3, "label", -1),
			a.integer(4, "pin", -1), (float)a.real(5, "thick", 0), (float)a.real(6, "resist", 0)));
		return levelValue(Level::VIA, result);
	} else if (fn == "route") {
		int result = (int)tech->wires.size();
		tech->wires.push_back(Routing(a.integer(0, "draw", -1, true), a.integer(1, "label", -1), a.integer(2, "pin", -1),
			(float)a.real(3, "thick", 0), (float)a.real(4, "resist", 0)));
		return levelValue(Level::ROUTE, result);
	} else if (fn == "spacing") {
		return Value::integer(tech->setSpacing(a.integer(0, "l0", -1, true), a.integer(1, "l1", -1, true), a.integer(2, "value", -1, true)));
	} else if (fn == "enclosing") {
		int l0 = a.integer(0, "l0", -1, true);
		if (l0 < 0) throw ScriptError("enclosing layer must be a paint layer.");
		return Value::integer(tech->setEnclosing(l0, a.integer(1, "l1", -1, true), a.integer(2, "lo", -1, true), a.integer(3, "hi", -1)));
	} else if (fn == "b_and" or fn == "b_or") {
		vector<int> layers;
		for (size_t i = 0; i < a.pos.size(); i++) layers.push_back(a.integer(i, "layer", -1));
		if (layers.size() < 2) throw ScriptError(fn + " requires at least two layers.");
		return Value::integer(fn == "b_and" ? tech->setAnd(layers) : tech->setOr(layers));
	} else if (fn == "b_not") {
		return Value::integer(tech->setNot(a.integer(0, "layer", -1, true)));
	} else if (fn == "bound") {
		tech->boundary = a.integer(0, "layer", -1, true);
		return Value::integer(tech->boundary);
	} else if (fn == "print") {
		string line;
		for (size_t i = 0; i < a.pos.size(); i++) {
			const Value &v = a.pos[i];
			line += (i ? " " : "") + (v.kind == Value::STR ? v.s : v.kind == Value::FLOAT ? to_string(v.f) : to_string(v.i));
		}
		printf("%s\n", line.c_str());
		return Value::none();
	}
	throw ScriptError("unknown function " + fn + "()");
}

// ----- Expressions, by recursive descent

class Parser {
public:
	Parser(const string &line, map<string, Value> &vars) : lexer(line), vars(vars) { advance(); }

	Value expression() { return orExpr(); }
	bool atEnd() const { return tok.kind == Token::END; }
	const Token &peek() const { return tok; }
	void advance() { tok = lexer.next(); }
	bool accept(const string &op) {
		if (tok.kind == Token::OP and tok.text == op) { advance(); return true; }
		return false;
	}
	void expect(const string &op) {
		if (not accept(op)) throw ScriptError("expected '" + op + "'" + (tok.text.empty() ? "" : " before '" + tok.text + "'"));
	}

private:
	Lexer lexer;
	Token tok;
	map<string, Value> &vars;

	bool acceptName(const string &word) {
		if (tok.kind == Token::NAME and tok.text == word) { advance(); return true; }
		return false;
	}

	Value orExpr() {
		Value v = andExpr();
		while (acceptName("or")) { Value r = andExpr(); v = v.truth() ? v : r; }
		return v;
	}
	Value andExpr() {
		Value v = notExpr();
		while (acceptName("and")) { Value r = notExpr(); v = v.truth() ? r : v; }
		return v;
	}
	Value notExpr() {
		if (acceptName("not")) return Value::boolean(not notExpr().truth());
		return comparison();
	}
	Value comparison() {
		Value v = sum();
		if (tok.kind == Token::OP and (tok.text == "==" or tok.text == "!=")) {
			bool eq = tok.text == "==";
			advance();
			Value r = sum();
			bool same = (v.isNumber() and r.isNumber()) ? v.number() == r.number() :
				(v.kind == r.kind and v.kind == Value::STR) ? v.s == r.s : v.kind == Value::NONE and r.kind == Value::NONE;
			return Value::boolean(eq ? same : not same);
		}
		return v;
	}
	static Value arith(const Value &a, const Value &b, char op) {
		if (op == '+' and a.kind == Value::STR and b.kind == Value::STR) return Value::str(a.s + b.s);
		if (not a.isNumber() or not b.isNumber()) throw ScriptError(string("'") + op + "' needs numbers");
		if (op == '/') return Value::real(a.number() / b.number());
		if (a.kind == Value::FLOAT or b.kind == Value::FLOAT) {
			double x = a.number(), y = b.number();
			return Value::real(op == '+' ? x + y : op == '-' ? x - y : x * y);
		}
		return Value::integer(op == '+' ? a.i + b.i : op == '-' ? a.i - b.i : a.i * b.i);
	}
	Value sum() {
		Value v = product();
		while (tok.kind == Token::OP and (tok.text == "+" or tok.text == "-")) {
			char op = tok.text[0];
			advance();
			v = arith(v, product(), op);
		}
		return v;
	}
	Value product() {
		Value v = unary();
		while (tok.kind == Token::OP and (tok.text == "*" or tok.text == "/")) {
			char op = tok.text[0];
			advance();
			v = arith(v, unary(), op);
		}
		return v;
	}
	Value unary() {
		if (accept("-")) {
			Value v = unary();
			if (v.kind == Value::FLOAT) return Value::real(-v.f);
			if (v.kind == Value::INT or v.kind == Value::BOOL) return Value::integer(-v.i);
			throw ScriptError("'-' needs a number");
		}
		if (accept("+")) return unary();
		return primary();
	}
	ValueList sequence(const string &close) {
		ValueList items;
		while (not accept(close)) {
			items.push_back(expression());
			if (not accept(",")) { expect(close); break; }
		}
		return items;
	}
	Value primary() {
		if (tok.kind == Token::NUMBER) {
			string text = tok.text;
			advance();
			char *end = nullptr;
			if (text.find_first_of(".eE") == string::npos) {
				long n = strtol(text.c_str(), &end, 0);
				if (*end == 0) return Value::integer(n);
			} else {
				double d = strtod(text.c_str(), &end);
				if (*end == 0) return Value::real(d);
			}
			throw ScriptError("bad number " + text);
		}
		if (tok.kind == Token::STRING) {
			string text = tok.text;
			advance();
			while (tok.kind == Token::STRING) { text += tok.text; advance(); }
			return Value::str(text);
		}
		if (accept("(")) {
			if (accept(")")) return Value::seq(Value::TUPLE, {});
			Value first = expression();
			if (accept(")")) return first;
			expect(",");
			ValueList items = {first};
			ValueList rest = sequence(")");
			items.insert(items.end(), rest.begin(), rest.end());
			return Value::seq(Value::TUPLE, items);
		}
		if (accept("[")) return Value::seq(Value::LIST, sequence("]"));
		if (tok.kind == Token::NAME) {
			string name = tok.text;
			advance();
			if (accept("(")) {
				Args a;
				a.fn = name;
				while (not accept(")")) {
					if (tok.kind == Token::NAME) {
						// A keyword argument, or an expression that starts with a name.
						Token saved = tok;
						Lexer savedLexer = lexer;
						advance();
						if (tok.kind == Token::OP and tok.text == "=") {
							advance();
							a.kw[saved.text] = expression();
						} else {
							tok = saved;
							lexer = savedLexer;
							a.pos.push_back(expression());
						}
					} else {
						a.pos.push_back(expression());
					}
					if (not accept(",")) { expect(")"); break; }
				}
				return call(a);
			}
			if (name == "True") return Value::boolean(true);
			if (name == "False") return Value::boolean(false);
			if (name == "None") return Value::none();
			auto it = vars.find(name);
			if (it == vars.end()) throw ScriptError("name '" + name + "' is not defined");
			return it->second;
		}
		throw ScriptError(tok.text.empty() ? "unexpected end of line" : "unexpected '" + tok.text + "'");
	}
};

// ----- Statements

struct Line {
	int number;
	int indent;
	string text;
};

// Lines without comments and blank lines, with brackets joined across line breaks.
vector<Line> logicalLines(istream &in) {
	vector<Line> lines;
	string raw, pending;
	int number = 0, start = 0, depth = 0;
	while (getline(in, raw)) {
		number++;
		if (not raw.empty() and raw.back() == '\r') raw.pop_back();
		// Strip a comment that isn't inside a string.
		char quote = 0;
		for (size_t i = 0; i < raw.size(); i++) {
			char c = raw[i];
			if (quote) {
				if (c == '\\') i++;
				else if (c == quote) quote = 0;
			} else if (c == '"' or c == '\'') {
				quote = c;
			} else if (c == '#') {
				raw.resize(i);
				break;
			} else if (c == '(' or c == '[' or c == '{') {
				depth++;
			} else if (c == ')' or c == ']' or c == '}') {
				depth--;
			}
		}
		if (pending.empty()) start = number;
		pending += (pending.empty() ? "" : " ") + raw;
		if (depth > 0 or (not pending.empty() and pending.back() == '\\')) {
			if (not pending.empty() and pending.back() == '\\') pending.pop_back();
			continue;
		}
		size_t first = pending.find_first_not_of(" \t");
		if (first != string::npos) {
			int indent = 0;
			for (size_t i = 0; i < first; i++) indent += pending[i] == '\t' ? 8 - indent % 8 : 1;
			lines.push_back({start, indent, pending.substr(first)});
		}
		pending.clear();
		depth = 0;
	}
	return lines;
}

class Interpreter {
public:
	Interpreter(const vector<Line> &lines, const string &path) : lines(lines), path(path) {}

	void run() {
		size_t i = 0;
		block(i, lines.empty() ? 0 : lines[0].indent, true);
	}

private:
	const vector<Line> &lines;
	string path;
	map<string, Value> vars;

	[[noreturn]] void fail(const Line &line, const string &message) {
		throw ScriptError(path + ":" + to_string(line.number) + ": " + message);
	}

	static bool startsWith(const string &text, const string &word) {
		return text.compare(0, word.size(), word) == 0 and (text.size() == word.size() or not (isalnum((unsigned char)text[word.size()]) or text[word.size()] == '_'));
	}

	Value evaluate(const Line &line, const string &text) {
		try {
			Parser p(text, vars);
			Value v = p.expression();
			if (not p.atEnd()) throw ScriptError("unexpected '" + p.peek().text + "'");
			return v;
		} catch (const ScriptError &e) {
			if (string(e.what()).rfind(path + ":", 0) == 0) throw;
			fail(line, e.what());
		}
	}

	// Run the lines at this indentation from i; with run false, only skip them.
	void block(size_t &i, int indent, bool run) {
		while (i < lines.size() and lines[i].indent >= indent) {
			const Line &line = lines[i];
			if (line.indent > indent) fail(line, "unexpected indent");
			const string &text = line.text;
			if (startsWith(text, "if")) {
				bool taken = false;
				while (true) {
					const Line &head = lines[i];
					string kind = startsWith(head.text, "if") ? "if" : startsWith(head.text, "elif") ? "elif" : "else";
					if (head.text.back() != ':') fail(head, kind + " needs a ':' at the end of the line (one statement per line)");
					bool cond = false;
					if (kind != "else") {
						string expr = head.text.substr(kind.size(), head.text.size() - kind.size() - 1);
						cond = run and not taken and evaluate(head, expr).truth();
					} else {
						cond = run and not taken;
					}
					i++;
					if (i >= lines.size() or lines[i].indent <= indent) fail(head, "expected an indented block");
					block(i, lines[i].indent, cond);
					taken = taken or cond;
					if (i < lines.size() and lines[i].indent == indent and kind != "else" and
						(startsWith(lines[i].text, "elif") or startsWith(lines[i].text, "else"))) continue;
					break;
				}
				continue;
			}
			i++;
			if (not run) continue;
			if (startsWith(text, "from") or startsWith(text, "import") or text == "pass") continue;
			if (startsWith(text, "for") or startsWith(text, "while") or startsWith(text, "def") or startsWith(text, "class") or
				startsWith(text, "with") or startsWith(text, "try"))
				fail(line, "this technology file needs Python, which the web build doesn't have; it reads assignments, calls and if blocks only");
			// name = expression, or an expression on its own.
			size_t eq = text.find('=');
			string name = eq == string::npos ? "" : text.substr(0, eq);
			name.erase(name.find_last_not_of(" \t") + 1);
			bool plain = not name.empty() and (isalpha((unsigned char)name[0]) or name[0] == '_') and text[eq + 1] != '=';
			for (char c : name) plain = plain and (isalnum((unsigned char)c) or c == '_');
			if (plain) {
				vars[name] = evaluate(line, text.substr(eq + 1));
			} else {
				evaluate(line, text);
			}
		}
	}
};

}

bool loadTech(void *dst, string path, vector<string> args) {
	if (filesystem::is_directory(path)) {
		path = (filesystem::path(path) / "tech.py").string();
	}
	ifstream in(path);
	if (not in) {
		printf("technology file '%s' not found.\n", path.c_str());
		return false;
	}
	tech = (Tech*)dst;
	bool success = true;
	try {
		vector<Line> lines = logicalLines(in);
		Interpreter(lines, path).run();
	} catch (const exception &e) {
		printf("%s\n", e.what());
		success = false;
	}
	tech = nullptr;
	return success;
}

}
