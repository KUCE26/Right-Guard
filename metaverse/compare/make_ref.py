"""헤드리스 비교 실험 결과(test/out/cmp_ref.json) → compare/ref.json (상황별로 장면을 합친 값)"""
import json, sys, datetime
src = sys.argv[1] if len(sys.argv) > 1 else 'test/out/cmp_ref.json'
runs = json.load(open(src))
NAMES = {'normal': '평상시 낮', 'rush': '출퇴근', 'school': '하교 시간'}
SUM = ['turns', 'required', 'complied', 'reqIntent', 'compIntent', 'close', 'near', 'crash', 'rgStops', 'falseStops', 'pedCross',
       'pedYieldFail', 'pedConflict', 'det', 'detOk', 'warnOk', 'ep', 'epFalse']
def agg(rs):
    o = {k: sum(r['s'][k] for r in rs) for k in SUM}
    mins = sum(r['s']['min'] for r in rs)
    o['min'] = mins
    tt = sum(r['s']['turnTime'] * r['s']['turns'] for r in rs if r['s']['turnTime'] is not None)
    o['turnTime'] = tt / o['turns'] if o['turns'] else None
    ld = [(r['s']['lead'], r['s']['detOk']) for r in rs if r['s']['lead'] is not None]
    o['lead'] = sum(a * b for a, b in ld) / sum(b for _, b in ld) if ld else None
    r_ = lambda a, b: (a / b) if b else None
    o['compliance'] = r_(o['complied'], o['required'])
    o['complianceIntent'] = r_(o['compIntent'], o['reqIntent'])
    o['yieldFailRate'] = r_(o['pedYieldFail'], o['pedCross'])
    o['detRate'] = r_(o['detOk'], o['det'])
    o['warnRate'] = r_(o['warnOk'], o['det'])
    o['falseRate'] = r_(o['epFalse'], o['ep'])
    o['turnsPerHour'] = o['turns'] / mins * 60 if mins else None
    # 장면별 흔들림 (이행률·아찔한 순간 100대당)
    o['range'] = {
        'compliance': [min(r['s']['compliance'] or 0 for r in rs), max(r['s']['compliance'] or 0 for r in rs)],
        'near100': [min((r['s']['near'] / r['s']['turns'] * 100) if r['s']['turns'] else 0 for r in rs), max((r['s']['near'] / r['s']['turns'] * 100) if r['s']['turns'] else 0 for r in rs)],
    }
    return o
out = {'date': datetime.date.today().isoformat(), 'scenarios': []}
scns = []
for r in runs:
    if r['scn'] not in scns: scns.append(r['scn'])
seeds = sorted({r['seed'] for r in runs})
out['seeds'] = len(seeds)
out['minutes'] = round(runs[0]['s']['min'])
out['assume'] = {'pSelf': 0.1, 'pObey': 0.8, 'prt': 1.3}
for sc in scns:
    A = agg([r for r in runs if r['scn'] == sc and r['dev'] == 0])
    B = agg([r for r in runs if r['scn'] == sc and r['dev'] == 1])
    out['scenarios'].append({'key': sc, 'name': NAMES.get(sc, sc), 'A': A, 'B': B})
json.dump(out, open('compare/ref.json', 'w'), ensure_ascii=False, indent=1)
for s in out['scenarios']:
    a, b = s['A'], s['B']
    f = lambda v: '-' if v is None else f'{v*100:.0f}%'
    print(s['name'], 'turns', a['turns'], b['turns'], '| comp', f(a['compliance']), f(b['compliance']), '| intent', f(a['complianceIntent']), f(b['complianceIntent']),
          f"({a['compIntent']}/{a['reqIntent']} vs {b['compIntent']}/{b['reqIntent']})", '| near', a['near'], b['near'], '| crash', a['crash'], b['crash'],
          '| tt', round(a['turnTime'], 1), round(b['turnTime'], 1), '| pwait', f(a['yieldFailRate']), f(b['yieldFailRate']), '| det', f(b['detRate']), 'warn', f(b['warnRate']), 'false', f(b['falseRate']), 'lead', b['lead'] and round(b['lead'], 2))
