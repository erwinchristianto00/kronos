"""Generate the deterministic graphify code map; never import trading modules."""
import json
from pathlib import Path
from collections import Counter
from graphify.detect import detect, save_manifest
from graphify.extract import extract
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json
from graphify.diagnostics import diagnose_extraction, format_diagnostic_report

root = Path(__file__).resolve().parent
out = root / 'graphify-out'
out.mkdir(exist_ok=True)
d = detect(root)
if d['total_files'] > 500 or d['total_words'] > 2000000:
    raise SystemExit('Corpus exceeds skill limit; narrow the scope')
if any(d['files'].get(t) for t in ('document','paper','image','video')):
    raise SystemExit('This helper is code-only; semantic extraction requires the skill flow')
e = extract([Path(f) for f in d['files']['code']], cache_root=root)
g = build_from_json(e, root=str(root), directed=False)
if not g.number_of_nodes():
    raise SystemExit('Empty extraction, no graph overwritten')
c = cluster(g)
labels = {}
for cid, nodes in c.items():
    stems = Counter(Path(g.nodes[n].get('source_file') or 'core').stem for n in nodes)
    labels[cid] = stems.most_common(1)[0][0].replace('_', ' ').title()
if not to_json(g, c, str(out/'graph.json'), community_labels=labels):
    raise SystemExit('Refused to shrink previous graph')
report = generate(g, c, score_all(g,c), labels, god_nodes(g), surprising_connections(g,c),
                  d, {'input':0,'output':0}, str(root), suggested_questions=suggest_questions(g,c,labels))
(out/'GRAPH_REPORT.md').write_text(report)
(out/'.graphify_detect.json').write_text(json.dumps(d))
(out/'.graphify_extract.json').write_text(json.dumps(e))
save_manifest(d['files'], root=str(root))
print(format_diagnostic_report(diagnose_extraction(e,directed=False,root=str(root))))
print({'files':d['total_files'],'nodes':g.number_of_nodes(),'edges':g.number_of_edges(),'communities':len(c),
       'extractionTokens':0,'method':'deterministic AST; no semantic LLM extraction'})
