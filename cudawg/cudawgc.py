#!/usr/bin/env python3
"""cudawgc: transpile a (restricted) .cu file into
   - plain C host code that calls the cudawg runtime
   - one WGSL compute shader per __global__ kernel (embedded in the C output)

Usage: cudawgc.py input.cu -o output.c

Supported kernel subset (MVP):
  types int / unsigned / float / bool, pointer params to those types,
  threadIdx/blockIdx/blockDim/gridDim, if/else/for/while, casts like (float)x,
  __shared__ fixed-size arrays (1D/2D), __syncthreads, __device__ helpers
  with scalar params, common math (sqrtf, expf, fminf, ...), simple #defines.
Not supported: pointer arithmetic, ternary ?:, atomics, printf, dynamic shared mem.
"""
import re, sys, argparse

TYPES = {"int": "i32", "unsigned": "u32", "unsigned int": "u32", "float": "f32", "bool": "bool"}
MATH = {"sqrtf": "sqrt", "rsqrtf": "inverseSqrt", "expf": "exp", "__expf": "exp", "logf": "log",
        "__logf": "log", "powf": "pow", "fabsf": "abs", "fminf": "min", "fmaxf": "max",
        "floorf": "floor", "ceilf": "ceil", "sinf": "sin", "cosf": "cos", "tanhf": "tanh",
        "roundf": "round", "fmaf": "fma"}


# C identifiers that are keywords/reserved in WGSL -> get a trailing underscore
WGSL_RESERVED = set("""in out inout var let fn loop ref mod type shared filter target set get match self new
this template layout as async await impl mut move use where with yield final from module meta macro pass patch
precise priv pub unless unsafe alias override enable requires diagnostic discard continuing array atomic bitcast
vec2 vec3 vec4 mat2x2 mat3x3 mat4x4 i32 u32 f32 f16 ptr sampler texture_2d private storage uniform workgroup
function read write read_write const_assert fallthrough demote premerge regardless coherent smooth handle
binding group compute vertex fragment attribute varying package crate super trait try typeof unsized virtual""".split())


def rename_reserved(s):
    return re.sub(r"\b(%s)\b" % "|".join(sorted(WGSL_RESERVED, key=len, reverse=True)), r"\1_", s)


class CudawgError(Exception):
    pass


def match_brace(s, i, open_="{", close="}"):
    """i points at open_. Returns index just past the matching close."""
    depth = 0
    while i < len(s):
        c = s[i]
        if c == open_:
            depth += 1
        elif c == close:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise CudawgError("unbalanced " + open_)


def split_top(s, sep=","):
    out, depth, cur = [], 0, ""
    for c in s:
        if c in "([{<":
            depth += 1
        elif c in ")]}>":
            depth -= 1
        if c == sep and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += c
    if cur.strip():
        out.append(cur)
    return [x.strip() for x in out]


def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)
    return re.sub(r"//[^\n]*", "", s)


def collect_defines(src):
    d = {}
    for m in re.finditer(r"^\s*#\s*define\s+(\w+)\s+([^\n]+)$", src, re.M):
        d[m.group(1)] = m.group(2).strip()
    return d


def apply_defines(body, defines):
    for _ in range(5):  # allow nested defines
        new = body
        for k, v in defines.items():
            new = re.sub(r"\b%s\b" % re.escape(k), "(%s)" % v, new)
        if new == body:
            break
        body = new
    return body


def parse_param(p):
    p = re.sub(r"\b(__restrict__|__restrict|restrict)\b", "", p)
    is_const = bool(re.search(r"\bconst\b", p))
    p = re.sub(r"\bconst\b", "", p).strip()
    m = re.match(r"^(unsigned\s+int|unsigned|int|float|bool)\s*(\*?)\s*(\w+)$", p)
    if not m:
        raise CudawgError("unsupported kernel parameter: %r" % p)
    ctype = re.sub(r"\s+", " ", m.group(1))
    return {"ctype": ctype, "wtype": TYPES[ctype], "ptr": m.group(2) == "*",
            "const": is_const, "name": rename_reserved(m.group(3))}


def brace_bodies(s):
    """Wrap brace-less bodies of if/else/for/while in { }."""
    out, i = [], 0
    kw = re.compile(r"\b(if|for|while|else)\b")
    while True:
        m = kw.search(s, i)
        if not m:
            out.append(s[i:])
            break
        out.append(s[i:m.end()])
        j = m.end()
        if m.group(1) != "else":
            while s[j].isspace():
                j += 1
            if s[j] != "(":
                raise CudawgError("expected ( after " + m.group(1))
            k = match_brace(s, j, "(", ")")
            out.append(s[m.end():k])
            j = k
        # j is after the header; look at what follows
        k = j
        while k < len(s) and s[k].isspace():
            k += 1
        if s.startswith("{", k) or (m.group(1) == "else" and re.match(r"if\b", s[k:])):
            i = j
            continue
        # single statement: may itself be if/for/while -> recurse on it
        stmt_end = find_stmt_end(s, k)
        inner = brace_bodies(s[k:stmt_end])
        out.append(" { " + inner + " }")
        i = stmt_end
    return "".join(out)


def find_stmt_end(s, k):
    m = re.match(r"\s*(if|for|while)\b", s[k:])
    if m:
        j = k + m.end()
        while s[j].isspace():
            j += 1
        j = match_brace(s, j, "(", ")")
        while s[j].isspace():
            j += 1
        j = match_brace(s, j) if s[j] == "{" else find_stmt_end(s, j)
        r = re.match(r"\s*else\b", s[j:])
        if r and m.group(1) == "if":
            j2 = j + r.end()
            while s[j2].isspace():
                j2 += 1
            j = match_brace(s, j2) if s[j2] == "{" else find_stmt_end(s, j2)
        return j
    depth = 0
    for j in range(k, len(s)):
        if s[j] in "([":
            depth += 1
        elif s[j] in ")]":
            depth -= 1
        elif s[j] == ";" and depth == 0:
            return j + 1
    raise CudawgError("statement without ;")


def translate_body(body, defines):
    b = rename_reserved(apply_defines(body, defines))
    if "?" in b:
        raise CudawgError("ternary ?: not supported, use if/else")
    for bad in ("atomic", "printf", "malloc"):
        if re.search(r"\b%s\w*\s*\(" % bad, b):
            raise CudawgError("%s not supported in kernels (yet)" % bad)
    b = brace_bodies(b)
    b = re.sub(r"\b(threadIdx|blockIdx|blockDim|gridDim)\.([xyz])\b", r"\1_\2", b)
    b = re.sub(r"\b__syncthreads\s*\(\s*\)", "workgroupBarrier()", b)
    for k, v in MATH.items():
        b = re.sub(r"\b%s\s*\(" % k, v + "(", b)
    # float literals: 1.0f -> 1.0, 2f -> 2.0
    b = re.sub(r"\b(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?[fF]\b",
               lambda m: (m.group(1) if "." in m.group(1) else m.group(1) + ".0") + (m.group(2) or ""), b)
    # casts: (float)x  (int)(a+b)  (float)a[i]
    def cast(m):
        return "\x01%s\x01" % TYPES[re.sub(r"\s+", " ", m.group(1))]
    b = re.sub(r"\(\s*(unsigned\s+int|unsigned|int|float)\s*\)\s*(?=[\w(])", cast, b)
    b = close_casts(b)
    # ++i -> i++ (WGSL only has postfix as a statement)
    b = re.sub(r"(?<![\w\])])\+\+\s*(\w+)", r"\1++", b)
    b = re.sub(r"(?<![\w\])])--\s*(\w+)", r"\1--", b)
    b = translate_decls(b)
    return b


DECL = re.compile(r"(?<![\w.])(const\s+)?(unsigned\s+int|unsigned|int|float|bool)\s+(?=[A-Za-z_])")


def translate_decls(b):
    """int a = 1, b[4], c;  ->  var a: i32 = 1; var b: array<i32, 4>; var c: i32;"""
    out, i = [], 0
    while True:
        m = DECL.search(b, i)
        if not m:
            out.append(b[i:])
            return "".join(out)
        out.append(b[i:m.start()])
        end = m.end()
        depth = 0
        while end < len(b):
            c = b[end]
            if c in "([":
                depth += 1
            elif c in ")]":
                depth -= 1
            elif c == ";" and depth == 0:
                break
            end += 1
        t = TYPES[re.sub(r"\s+", " ", m.group(2))]
        parts = []
        for d in split_top(b[m.end():end]):
            dm = re.match(r"^(\w+)\s*((?:\[[^\]]+\])*)\s*(?:=\s*(.*))?$", d, re.S)
            if not dm:
                raise CudawgError("cannot parse declaration: " + d)
            ty = t
            for n in reversed(re.findall(r"\[([^\]]+)\]", dm.group(2))):
                ty = "array<%s, %s>" % (ty, n)
            kw = "let" if (m.group(1) and dm.group(3) is not None) else "var"
            parts.append("%s %s: %s%s" % (kw, dm.group(1), ty, "" if dm.group(3) is None else " = " + dm.group(3)))
        out.append("; ".join(parts))
        i = end  # keep the ';'


CAST_MARK = re.compile(r"\x01(i32|u32|f32)\x01\s*")


def close_casts(b):
    """'\x01f32\x01 operand' -> 'f32(operand)'. operand = (...) or name/number with [..]/(..) suffixes."""
    out, i = [], 0
    while True:
        m = CAST_MARK.search(b, i)
        if not m:
            out.append(b[i:])
            return "".join(out)
        out.append(b[i:m.start()])
        j = m.end()
        if b[j] == "(":
            k = match_brace(b, j, "(", ")")
            inner = b[j + 1:k - 1]
        else:
            mm = re.match(r"[\w.]+", b[j:])
            if not mm:
                raise CudawgError("cannot parse cast operand near: " + b[j:j + 20])
            k = j + mm.end()
            while k < len(b) and b[k] in "[(":
                k = match_brace(b, k, b[k], "]" if b[k] == "[" else ")")
            inner = b[j:k]
        out.append("%s(%s)" % (m.group(1), close_casts(inner)))
        i = k


def extract_functions(src, qualifier):
    """Yield (start, end, header, body) for functions declared with qualifier."""
    res = []
    for m in re.finditer(r"\b%s\b" % qualifier, src):
        p = src.index("(", m.end())
        q = match_brace(src, p, "(", ")")
        b = src.index("{", q)
        e = match_brace(src, b)
        # include anything like 'static' before qualifier on the same line
        start = m.start()
        res.append((start, e, src[m.end():q], src[b + 1:e - 1]))
    return res


def gen_device_fn(header, body, defines):
    header = re.sub(r"\b(__forceinline__|__noinline__|inline|static|__host__)\b", "", header).strip()
    m = re.match(r"^(unsigned\s+int|unsigned|int|float|bool|void)\s+(\w+)\s*\((.*)\)$", header, re.S)
    if not m:
        raise CudawgError("unsupported __device__ function: " + header)
    params = [parse_param(p) for p in split_top(m.group(3))] if m.group(3).strip() else []
    if any(p["ptr"] for p in params):
        raise CudawgError("pointer params in __device__ functions not supported: " + m.group(2))
    ret = "" if m.group(1) == "void" else " -> " + TYPES[re.sub(r"\s+", " ", m.group(1))]
    ps = ", ".join("%s_in: %s" % (p["name"], p["wtype"]) for p in params)
    # WGSL params are immutable; copy into vars so the body can assign them
    copies = "".join("  var %s = %s_in;\n" % (p["name"], p["name"]) for p in params)
    return "fn %s(%s)%s {\n%s%s\n}\n" % (m.group(2), ps, ret, copies, translate_body(body, defines))


def gen_kernel(name, params, body, shared, device_fns, defines):
    L = ["// generated by cudawgc from kernel '%s'" % name,
         "override _cwbx: u32 = 1u;", "override _cwby: u32 = 1u;", "override _cwbz: u32 = 1u;"]
    binding = 0
    for p in params:
        if p["ptr"]:
            acc = "read" if p["const"] else "read_write"
            L.append("@group(0) @binding(%d) var<storage, %s> %s: array<%s>;" % (binding, acc, p["name"], p["wtype"]))
            binding += 1
    scalars = [p for p in params if not p["ptr"]]
    if scalars:
        L.append("struct _CwParams {")
        L += ["  %s: %s," % (p["name"], p["wtype"]) for p in scalars]
        L.append("}")
        L.append("@group(0) @binding(%d) var<uniform> _cwP: _CwParams;" % binding)
    for (t, n, dims) in shared:
        ty = TYPES[t]
        for d in reversed(dims):
            ty = "array<%s, %s>" % (ty, d)
        L.append("var<workgroup> %s: %s;" % (n, ty))
    L += device_fns
    L.append("@compute @workgroup_size(_cwbx, _cwby, _cwbz)")
    L.append("fn main(@builtin(local_invocation_id) _lid: vec3<u32>, @builtin(workgroup_id) _wid: vec3<u32>, "
             "@builtin(num_workgroups) _nwg: vec3<u32>) {")
    for a in "xyz":
        L.append("  let threadIdx_%s = i32(_lid.%s); let blockIdx_%s = i32(_wid.%s); "
                 "let blockDim_%s = i32(_cwb%s); let gridDim_%s = i32(_nwg.%s);" % (a, a, a, a, a, a, a, a))
    for p in scalars:
        L.append("  var %s = _cwP.%s;" % (p["name"], p["name"]))
    L.append(translate_body(body, defines))
    L.append("}")
    return "\n".join(L) + "\n"


def c_string(s):
    return "\n".join('  "%s\\n"' % line.replace("\\", "\\\\").replace('"', '\\"') for line in s.splitlines())


def transpile(src):
    defines = collect_defines(src)
    clean = strip_comments(src)

    # __device__ helpers (exclude '__device__' used as a qualifier on globals; MVP: functions only)
    device_fns, cut = [], []
    for (s, e, header, body) in extract_functions(clean, "__device__"):
        device_fns.append(gen_device_fn(header, body, defines))
        cut.append((s, e, ""))

    kernels = []
    for (s, e, header, body) in extract_functions(clean, "__global__"):
        m = re.match(r"^\s*void\s+(\w+)\s*\((.*)\)\s*$", header, re.S)
        if not m:
            raise CudawgError("bad kernel header: " + header)
        name = m.group(1)
        params = [parse_param(p) for p in split_top(m.group(2))]
        shared = []
        def grab(mm):
            t = re.sub(r"\s+", " ", mm.group(1))
            dims = [apply_defines(d, defines) for d in re.findall(r"\[([^\]]+)\]", mm.group(3))]
            shared.append((t, mm.group(2), dims))
            return ""
        body = re.sub(r"__shared__\s+(unsigned\s+int|unsigned|int|float)\s+(\w+)\s*((?:\[[^\]]+\])+)\s*;", grab, body)
        if "__shared__" in body:
            raise CudawgError("unsupported __shared__ declaration in " + name)
        wgsl = gen_kernel(name, params, body, shared, device_fns, defines)
        kinds = "".join(("r" if p["const"] else "w") if p["ptr"] else {"i32": "i", "u32": "u", "f32": "f", "bool": "u"}[p["wtype"]]
                        for p in params)
        cparams = ", ".join("%s%s%s %s" % ("const " if p["const"] else "", p["ctype"], "*" if p["ptr"] else "", p["name"])
                            for p in params)
        argv = ", ".join("(void*)&" + p["name"] for p in params)
        wrapper = (
            "static cudawg_kernel __cudawg_k_%s = { \"%s\", \"%s\", -1,\n%s\n};\n"
            "static cudaError_t %s__launch(dim3 __g, dim3 __b, %s) {\n"
            "  void *__args[] = { %s };\n"
            "  return cudawgLaunch(&__cudawg_k_%s, __g, __b, __args);\n}\n"
        ) % (name, name, kinds, c_string(wgsl), name, cparams, argv, name)
        cut.append((s, e, wrapper))
        kernels.append((name, wgsl))

    host = clean
    for (s, e, rep) in sorted(cut, key=lambda x: -x[0]):
        host = host[:s] + rep + host[e:]

    # kernel<<<g, b[, shm, stream]>>>(args)  ->  kernel__launch(DIM3(g), DIM3(b), args)
    def launch(m):
        cfg = split_top(m.group(2))
        return "%s__launch(CUDAWG_DIM3(%s), CUDAWG_DIM3(%s), " % (m.group(1), cfg[0], cfg[1])
    host = re.sub(r"\b(\w+)\s*<<<(.*?)>>>\s*\(", launch, host, flags=re.S)
    host = re.sub(r"\(\s*(CUDAWG_DIM3\([^)]*\)\s*,\s*CUDAWG_DIM3\(.*?\)), \)", r"(\1)", host)
    # dim3 v(a, b);  ->  dim3 v = cudawg_dim3(a, b, 1);
    def dim3(m):
        a = split_top(m.group(2)) + ["1", "1"]
        return "dim3 %s = cudawg_dim3(%s, %s, %s);" % (m.group(1), a[0], a[1], a[2])
    host = re.sub(r"\bdim3\s+(\w+)\s*\(([^;]*)\)\s*;", dim3, host)
    # feature-test macros (#define _POSIX_C_SOURCE ...) must stay before any include
    feat = re.findall(r"^[ \t]*#[ \t]*define[ \t]+_[A-Z0-9_]+\b[^\n]*\n", host, re.M)
    host = re.sub(r"^[ \t]*#[ \t]*define[ \t]+_[A-Z0-9_]+\b[^\n]*\n", "", host, flags=re.M)
    host = "".join(feat) + '#include "cuda_runtime.h"\n' + host
    return host, kernels


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--dump-wgsl", action="store_true", help="also write <kernel>.wgsl files")
    a = ap.parse_args()
    try:
        host, kernels = transpile(open(a.input).read())
    except CudawgError as e:
        sys.exit("cudawgc: error: %s" % e)
    open(a.output, "w").write(host)
    if a.dump_wgsl:
        for name, w in kernels:
            open(name + ".wgsl", "w").write(w)


if __name__ == "__main__":
    main()
