"""Compares how the web, Android and iOS SDKs read a folder of stored XFDF (e.g. markup saved by PDFTron WebViewer).

1. Put the XFDF files in one folder, e.g. /tmp/legacy/xfdf (subfolders are fine).
2. Write each platform's reading (each test skips unless LEGACY_DIR and LEGACY_OUT are set):
     web:     cd packages/react-viewer && LEGACY_DIR=/tmp/legacy/xfdf LEGACY_OUT=/tmp/legacy/web.jsonl LEGACY_START=0 LEGACY_COUNT=1500 npx vitest run test/legacy-xfdf-check.test.ts
              (repeat with LEGACY_START=1500, 3000, ... : jsdom keeps memory between files)
     Android: cd mobile/android && LEGACY_DIR=... LEGACY_OUT=/tmp/legacy/android.jsonl ./gradlew :pdfstudio:testDebugUnitTest --tests '*LegacyXfdfCheckTest' --rerun-tasks
     iOS:     cd mobile/ios/PDFStudioKit && LEGACY_DIR=... LEGACY_OUT=/tmp/legacy/ios.jsonl swift test --filter LegacyXfdfCheckTests
3. python3 scripts/compare_legacy_xfdf.py /tmp/legacy

Reports reader errors, files where the number of marks differs, and every field that differs per kind of mark.
"""
import json, sys, collections
S = sys.argv[1]
TIME = {'createdAt', 'modifiedAt'}

def norm(v):
    if isinstance(v, float): return round(v, 2) + 0.0
    if isinstance(v, int) and not isinstance(v, bool): return float(v)
    if isinstance(v, list): return [norm(x) for x in v]
    if isinstance(v, dict): return {k: norm(x) for k, x in sorted(v.items())}
    if isinstance(v, str) and v.startswith('#') and len(v) in (7, 9): return v.lower()
    return v

def close(a, b):
    if isinstance(a, float) and isinstance(b, float): return abs(a - b) <= 0.02
    if isinstance(a, list) and isinstance(b, list): return len(a) == len(b) and all(close(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict): return a.keys() == b.keys() and all(close(a[k], b[k]) for k in a)
    return a == b

files = 0; anns = collections.Counter(); count_diff = []; err = collections.Counter()
field_diff = collections.Counter(); field_ex = {}; time_diff = collections.Counter(); time_ex = {}
missing_field = collections.Counter(); missing_ex = {}
import re
def index(name):
    fh = open(f'{S}/{name}.jsonl', 'rb'); idx = {}; pos = 0
    for line in fh:
        m = re.match(rb'\{"file":\s*"([^"]+)"', line)
        key = (m.group(1).decode() if m else json.loads(line)['file']).replace('\\/', '/')
        idx[key] = pos; pos += len(line)
    return fh, idx
H = {n: index(n) for n in ('web', 'android', 'ios')}
def get(n, f):
    fh, idx = H[n]; fh.seek(idx[f]); return json.loads(fh.readline())
assert H['web'][1].keys() == H['android'][1].keys() == H['ios'][1].keys(), 'file sets differ'
for f in sorted(H['web'][1]):
    W, A, I = get('web', f), get('android', f), get('ios', f)
    files += 1; f = W['file']
    for name, r in (('android', A), ('ios', I)):
        if 'error' in r and 'error' not in W: err[name] += 1
    if any('error' in r for r in (W, A, I)): continue
    for name, r in (('android', A), ('ios', I)):
        if bool(r.get('partial')) != bool(W.get('partial')): field_diff[(name, '*', 'partial')] += 1
    wa = {a['id']: a for a in W['annotations']}
    for name, r in (('android', A), ('ios', I)):
        other = {a['id']: a for a in r['annotations']}
        if len(r['annotations']) != len(W['annotations']):
            count_diff.append((name, f, len(W['annotations']), len(r['annotations'])))
        elif other.keys() != wa.keys():
            # marks without a name get a random id in each reader: pair them by their order in the file
            other = {w['id']: o for w, o in zip(W['annotations'], r['annotations'])}
        for i, w in wa.items():
            o = other.get(i)
            if o is None: continue
            kind = w.get('kind'); anns[(name, kind)] += 1
            for k in set(w) | set(o):
                if k == 'id': continue
                if k in TIME:
                    if w.get(k) != o.get(k):
                        time_diff[(name, k)] += 1; time_ex.setdefault((name, k), (f, i, w.get(k), o.get(k)))
                    continue
                a, b = norm(w.get(k)), norm(o.get(k))
                if k not in o or k not in w:
                    missing_field[(name, kind, k, 'only web' if k in w else f'only {name}')] += 1
                    missing_ex.setdefault((name, kind, k), (f, i, json.dumps(w.get(k))[:160], json.dumps(o.get(k))[:160]))
                elif not close(a, b):
                    field_diff[(name, kind, k)] += 1
                    field_ex.setdefault((name, kind, k), (f, i, json.dumps(w.get(k))[:160], json.dumps(o.get(k))[:160]))

print('files', files, 'reader errors (where web had none)', dict(err))
print('marks compared:', {n: sum(v for (m, _), v in anns.items() if m == n) for n in ('android', 'ios')})
print('\nfiles where the NUMBER of marks differs:', len(count_diff))
for x in count_diff[:8]: print('  ', x)
print('\nfields present on one side only (platform, kind, field, side): count')
for k, v in missing_field.most_common(40): print('  ', k, v, '| e.g.', missing_ex.get(k[:3]))
print('\nfields with different values (platform, kind, field): count')
for k, v in field_diff.most_common(40): print('  ', k, v, '| e.g.', field_ex.get(k))
print('\ntimestamps differing:', dict(time_diff)); [print('  ', k, v) for k, v in time_ex.items()]
