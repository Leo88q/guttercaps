#!/usr/bin/env python3
# Signature-style security scan of programs/**/*.rs — the same categories the Watchtower OS v3
# "Phase 1 Audit" (2026-09-23, 188 raw findings for guttercaps) reports: div-by-zero, missing
# signer / owner checks, PDA seed collisions, token-account constraints, plus raw arithmetic, CPI
# targets, init_if_needed, close, remaining_accounts, lamport moves, casts and indexing.
#
# It prints RAW HITS ONLY (≈1 200 at HEAD) — every hit needs a human verdict. The triage of the
# 2026-09-23 run, hit by hit, lives in scan triage 2026-09-23. Nothing here is a CI
# gate: the point is reproducibility of the numbers, not a lint.
#
#   python3 scripts/sec-scan.py programs > /tmp/scan.out
import os, re, sys, json, collections

ROOT = sys.argv[1] if len(sys.argv) > 1 else 'programs'
files = []
for dp, dn, fn in os.walk(ROOT):
    if '/target' in dp: continue
    for f in fn:
        if f.endswith('.rs'): files.append(os.path.join(dp, f))
files.sort()

def strip_comments_and_strings(line):
    # remove string literals and byte-string literals, then // comments
    out = []; i = 0; n = len(line)
    while i < n:
        c = line[i]
        if c == '"':
            j = i + 1
            while j < n and line[j] != '"':
                if line[j] == '\\': j += 1
                j += 1
            out.append('""'); i = j + 1; continue
        if c == '/' and i + 1 < n and line[i+1] == '/':
            break
        out.append(c); i += 1
    return ''.join(out)

hits = collections.defaultdict(list)
def hit(cat, f, ln, text, extra=''):
    hits[cat].append((f, ln, text.strip()[:160], extra))

# ---------------------------------------------------------------- per-line scans
ARITH_RE = re.compile(r'(?<![+\-*/=!<>&|^])\s([+\-*])\s(?![=>*&])')
DIV_RE = re.compile(r'(?<![/*])\s([/%])\s')
for f in files:
    src = open(f).read().splitlines()
    in_block_comment = False
    in_test = False
    for i, raw in enumerate(src, 1):
        s = raw.strip()
        if s.startswith('#[cfg(test)]'): in_test = True
        if in_block_comment:
            if '*/' in raw: in_block_comment = False
            continue
        if s.startswith('/*'):
            if '*/' not in raw: in_block_comment = True
            continue
        if s.startswith('//'): continue
        code = strip_comments_and_strings(raw)
        if in_test: continue
        # divisions / modulo
        for m in DIV_RE.finditer(code):
            after = code[m.end():].strip()
            tok = re.match(r'[A-Za-z_][A-Za-z0-9_:.()\[\]]*|\d[\d_]*', after)
            tok = tok.group(0) if tok else after[:20]
            kind = 'lit' if re.match(r'\d', tok) else ('const' if re.match(r'[A-Z][A-Z0-9_:]*$', tok.split('(')[0]) else 'var')
            hit('DIV', f, i, raw, f'{m.group(1)} by {kind}:{tok}')
        if 'checked_div' in code or 'checked_rem' in code:
            hit('DIV', f, i, raw, 'checked_div/rem')
        # raw arithmetic (overflow-checks=true → panic, not wrap)
        if not re.search(r'seeds\s*=|require!|msg!|emit!|#\[', code):
            for m in ARITH_RE.finditer(code):
                # skip negative literals, deref, ranges, generics
                seg = code[max(0, m.start()-25):m.end()+25]
                if re.search(r'\bfn\b|->|impl|where|as_ref|\[b"', seg): continue
                hit('ARITH', f, i, raw, m.group(1))
        # CPI
        if re.search(r'\binvoke(_signed)?\s*\(', code): hit('CPI', f, i, raw, 'invoke')
        if 'CpiContext::new' in code: hit('CPI', f, i, raw, 'CpiContext')
        # remaining accounts
        if 'remaining_accounts' in code: hit('REMAINING', f, i, raw)
        # lamport manipulation
        if 'try_borrow_mut_lamports' in code or 'lamports.borrow_mut' in code: hit('LAMPORTS', f, i, raw)
        if re.search(r'\.(resize|realloc)\(', code): hit('RESIZE', f, i, raw)
        if 'Account::try_from' in code or 'AccountLoader::try_from' in code or 'try_from_unchecked' in code: hit('TRYFROM', f, i, raw)
        if re.search(r'\bunwrap\(\)|\bexpect\(', code): hit('UNWRAP', f, i, raw)
        if re.search(r'\bas u(8|16|32|64)\b|\bas i64\b|\bas usize\b', code): hit('CAST', f, i, raw)
        if re.search(r'\[[a-z_]+\s*(as usize)?\]', code) and 'seeds' not in code and 'let' not in code.split('=')[0]:
            hit('INDEX', f, i, raw)
        if 'find_program_address' in code or 'create_program_address' in code: hit('PDA_DERIVE', f, i, raw)
        if 'get_unchecked' in code or 'unsafe' in code: hit('UNSAFE', f, i, raw)

# ---------------------------------------------------------------- Accounts structs
struct_re = re.compile(r'#\[derive\(Accounts\)\]')
for f in files:
    src = open(f).read()
    lines = src.splitlines()
    idx = 0
    while True:
        m = struct_re.search(src, idx)
        if not m: break
        # find struct header
        hdr = re.compile(r'pub struct (\w+)<[^>]*>\s*\{').search(src, m.end())
        if not hdr: break
        name = hdr.group(1)
        # find matching closing brace
        depth = 0; j = hdr.end() - 1
        while j < len(src):
            if src[j] == '{': depth += 1
            elif src[j] == '}':
                depth -= 1
                if depth == 0: break
            j += 1
        body = src[hdr.end():j]
        start_line = src[:hdr.start()].count('\n') + 1
        idx = j
        # struct-level: fields pinned through another field's has_one = X / address = X.key()
        pinned = set(re.findall(r'has_one\s*=\s*(\w+)', body))
        pinned |= set(re.findall(r'(?:token|associated_token|mint)::authority\s*=\s*(\w+)', body)) & set()  # authority refs don't pin
        # split fields: accumulate attrs/doc until 'pub name: type,'
        attrs = []; docs = []
        for k, ln in enumerate(body.splitlines()):
            s = ln.strip()
            if not s: continue
            if s.startswith('///'): docs.append(s); continue
            if s.startswith('#['):
                attrs.append(s)
                # multi-line attribute: continue until balanced
                continue
            if s.startswith('pub ') and ':' in s:
                fm = re.match(r'pub (\w+):\s*(.+?),?\s*$', s)
                if not fm: attrs=[]; docs=[]; continue
                fname, ftype = fm.group(1), fm.group(2)
                attr = ' '.join(attrs)
                doc = ' '.join(docs)
                ln_no = start_line + k + 1
                loc = f'{f}:{ln_no} {name}.{fname}'
                is_signer = 'Signer<' in ftype or 'signer' in attr
                unchecked = 'UncheckedAccount' in ftype or 'AccountInfo' in ftype or 'SystemAccount' in ftype
                has_addr = 'address' in attr
                has_seeds = 'seeds' in attr
                has_owner = 'owner' in attr
                has_hasone = 'has_one' in attr
                has_constraint = 'constraint' in attr
                if re.match(r'(admin|authority|owner|buyer|seller|payer|signer|oracle|caller|pauser|cranker|bidder|beneficiary|challenger|opponent|user|staker|reporter|creator|treasury|new_admin)$', fname) and not is_signer and fname not in pinned and not has_addr:
                    hit('SIGNER', f, ln_no, f'{name}.{fname}: {ftype}  [{attr}]', 'named-like-authority but not Signer')
                if unchecked:
                    cons = [c for c, v in (('address', has_addr), ('seeds', has_seeds), ('owner', has_owner), ('has_one', has_hasone), ('constraint', has_constraint), ('signer', is_signer), ('pinned-by-has_one', fname in pinned)) if v]
                    hit('UNCHECKED', f, ln_no, f'{name}.{fname}: {ftype}  [{attr}]', ','.join(cons) or 'NO CONSTRAINT' + ('' if 'CHECK' in doc else ' (no /// CHECK)'))
                if fname.endswith('_program') and 'Program<' not in ftype and not has_addr:
                    hit('PROGRAM', f, ln_no, f'{name}.{fname}: {ftype}  [{attr}]', 'program account not pinned')
                if 'TokenAccount' in ftype:
                    cons = [c for c in ('token::mint', 'token::authority', 'associated_token', 'address', 'constraint', 'seeds') if c in attr]
                    hit('TOKEN', f, ln_no, f'{name}.{fname}: {ftype}  [{attr}]', ','.join(cons) or 'NO CONSTRAINT')
                if re.search(r"Account<'info, Mint>|InterfaceAccount<'info, Mint>", ftype):
                    cons = [c for c in ('mint::', 'address', 'constraint', 'seeds') if c in attr]
                    hit('MINT', f, ln_no, f'{name}.{fname}: {ftype}  [{attr}]', ','.join(cons) or 'NO CONSTRAINT')
                if 'init_if_needed' in attr: hit('INIT_IF_NEEDED', f, ln_no, f'{name}.{fname}  [{attr}]')
                if 'close' in attr: hit('CLOSE', f, ln_no, f'{name}.{fname}  [{attr}]')
                if re.search(r"Account<'info, \w+>|Box<Account<'info, \w+>>", ftype) and 'mut' in attr and not (has_seeds or has_hasone or has_constraint or has_addr):
                    hit('UNBOUND_MUT', f, ln_no, f'{name}.{fname}: {ftype}  [{attr}]', 'mut account without seeds/has_one/constraint')
                attrs = []; docs = []

# ---------------------------------------------------------------- PDA seeds table
seed_re = re.compile(r'seeds\s*=\s*\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]')
fpa_re = re.compile(r'find_program_address\(\s*&\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]')
seeds = collections.defaultdict(list)
for f in files:
    src = open(f).read()
    for rx, kind in ((seed_re, 'anchor'), (fpa_re, 'fpa')):
        for m in rx.finditer(src):
            body = ' '.join(m.group(1).split())
            ln = src[:m.start()].count('\n') + 1
            pm = re.match(r'(b"[^"]*"|[A-Za-z_:]+)', body)
            prefix = pm.group(1) if pm else '?'
            seeds[prefix].append((f, ln, kind, body))

print(f'FILES {len(files)}  LINES {sum(len(open(x).read().splitlines()) for x in files)}')
order = ['DIV', 'ARITH', 'SIGNER', 'UNCHECKED', 'PROGRAM', 'TOKEN', 'MINT', 'UNBOUND_MUT', 'INIT_IF_NEEDED', 'CLOSE', 'CPI', 'REMAINING', 'TRYFROM', 'LAMPORTS', 'RESIZE', 'UNWRAP', 'CAST', 'INDEX', 'PDA_DERIVE', 'UNSAFE']
total = 0
for cat in order:
    print(f'\n===== {cat}: {len(hits[cat])} =====')
    total += len(hits[cat])
    for (f, ln, text, extra) in hits[cat]:
        print(f'{f}:{ln}: {text}' + (f'    <{extra}>' if extra else ''))
print(f'\n===== PDA SEED PREFIXES: {len(seeds)} =====')
for p, lst in sorted(seeds.items()):
    shapes = collections.Counter(re.sub(r'\s+', '', b) for (_, _, _, b) in lst)
    print(f'{p}: {len(lst)} uses, {len(shapes)} shapes')
    for shape, c in shapes.items(): print(f'      {c}x {shape[:150]}')
print(f'\nTOTAL RAW HITS {total}')
