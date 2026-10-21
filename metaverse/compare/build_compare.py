"""compare.src.html + 미리 돌려 본 결과(ref.json) → compare.html"""
import json, os, sys
SRC = os.path.join(os.path.dirname(__file__), 'compare.src.html')
REF = os.path.join(os.path.dirname(__file__), 'ref.json')
outs = sys.argv[1:] or [os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'compare.html')]
html = open(SRC, encoding='utf-8').read()
ref = json.load(open(REF, encoding='utf-8')) if os.path.exists(REF) else None
html = html.replace('/*__REF__*/null', json.dumps(ref, ensure_ascii=False, separators=(',', ':')) if ref else 'null')
for o in outs:
    open(o, 'w', encoding='utf-8').write(html)
    print('wrote', o, len(html))
