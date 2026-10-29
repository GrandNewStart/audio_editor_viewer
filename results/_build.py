"""Merge _labels/*.txt into mmae_action_sequences.csv + summary (run once; kept for re-runs)."""
import collections, csv, glob, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
META = os.path.join(HERE, "..", "data", "MMAE_data", "metadata.csv")
DSP_OPS = {"volume", "speed", "pitch", "cut", "mute", "insert", "mix", "repeat",
           "stretch_span", "reverb", "eq", "fade", "normalize", "reverse"}   # src/tools/dsp.py

csv.field_size_limit(10 ** 9)
rows = list(csv.DictReader(open(META, encoding="utf-8")))
labels = {}
for f in sorted(glob.glob(os.path.join(HERE, "_labels", "*.txt"))):
    for line in open(f, encoding="utf-8"):
        if line.strip():
            i, seq = line.rstrip("\n").split("|", 1)
            assert int(i) not in labels, f"duplicate {i}"
            labels[int(i)] = seq.strip()
missing = sorted(set(range(len(rows))) - set(labels))
assert not missing, f"missing {missing[:20]}"

def expand(tok):
    tok = tok.strip()
    if tok == "S": return "Separate"
    if tok == "G": return "Generate"
    if tok == "GS": return "GenSound"   # TangoFlux generate_sound (src/tools/t2a.py)
    if tok.startswith("D:"):
        op = tok[2:]
        assert op in DSP_OPS, f"unknown DSP op {op}"
        return "DSP-" + op
    if tok.startswith("C:"): return "Custom-" + tok[2:]
    raise ValueError(tok)

out, custom, dsp, kinds = [], collections.Counter(), collections.Counter(), collections.Counter()
first = collections.Counter()
FAMS = ["DSP", "Separate", "Generate", "GenSound", "Custom"]
for i, r in enumerate(rows):
    rounds = [[expand(t) for t in rnd.split(">")] for rnd in labels[i].split("||")]
    seq = " | ".join(("R%d: " % (k + 1) if len(rounds) > 1 else "") + " → ".join(rd)
                     for k, rd in enumerate(rounds))
    flat = [a for rd in rounds for a in rd]
    fam = {a.split("-")[0] for a in flat}
    for a in set(flat):
        if a.startswith("Custom-"): custom[a] += 1
        if a.startswith("DSP-"): dsp[a] += 1
    kinds["+".join(x for x in FAMS if x in fam)] += 1
    out.append({"index": i, "id": r["id"], "complexity": r["complexity"], "modality": r["modality"],
                "num_audios": r["num_audios"], "instruction": r["instruction"],
                "actions": seq, "n_steps": len(flat),
                "uses_dsp": int("DSP" in fam), "uses_separate": int("Separate" in fam),
                "uses_generate": int("Generate" in fam), "uses_gensound": int("GenSound" in fam),
                "uses_custom": int("Custom" in fam)})

with open(os.path.join(HERE, "mmae_action_sequences.csv"), "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0]))
    w.writeheader(); w.writerows(out)

n = len(out)
fam_n = {k: sum(o["uses_" + k] for o in out) for k in ["dsp", "separate", "generate", "gensound", "custom"]}
only_existing = sum(1 for o in out if not o["uses_custom"])
json.dump({"n": n, "family": fam_n, "combos": kinds.most_common(), "dsp": dsp.most_common(),
           "custom": custom.most_common(), "no_custom": only_existing},
          open(os.path.join(HERE, "_stats.json"), "w"), ensure_ascii=False, indent=1)
print(n, fam_n, "no custom:", only_existing)
print(kinds.most_common(12)); print(dsp.most_common()); print(custom.most_common())
