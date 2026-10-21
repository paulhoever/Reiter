#!/usr/bin/env python3
"""Minimal .po -> .mo compiler (no msgfmt needed). Usage: mkmo.py po/de.po out.mo"""
import ast, struct, sys

def parse(path):
    msgs, mid, mstr, cur = {}, None, None, None
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line.startswith('msgid '):
            if mid is not None and mstr is not None:
                msgs[mid] = mstr
            mid, mstr, cur = ast.literal_eval(line[6:]), None, 'id'
        elif line.startswith('msgstr '):
            mstr, cur = ast.literal_eval(line[7:]), 'str'
        elif line.startswith('"'):
            v = ast.literal_eval(line)
            if cur == 'id': mid += v
            else: mstr += v
    if mid is not None and mstr is not None:
        msgs[mid] = mstr
    return msgs

msgs = parse(sys.argv[1])
keys = sorted(msgs)
ids = b''.join(k.encode() + b'\0' for k in keys)
strs = b''.join(msgs[k].encode() + b'\0' for k in keys)
n = len(keys)
off = 28 + n * 16
koffs, voffs, p = [], [], 0
for k in keys:
    koffs.append((len(k.encode()), off + p)); p += len(k.encode()) + 1
q = off + len(ids)
p = 0
for k in keys:
    voffs.append((len(msgs[k].encode()), q + p)); p += len(msgs[k].encode()) + 1
out = struct.pack('<7I', 0x950412de, 0, n, 28, 28 + n * 8, 0, 0)
out += b''.join(struct.pack('<2I', *x) for x in koffs) + b''.join(struct.pack('<2I', *x) for x in voffs)
open(sys.argv[2], 'wb').write(out + ids + strs)
