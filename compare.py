#!/usr/bin/env python3
"""Compare an Audio_editor run's output audio with the original MMAE source audio.

    .venv/bin/python compare.py runs/<experiment_name>              # browser viewer
    .venv/bin/python compare.py runs/<experiment_name> --csv m.csv   # metrics only

The output directory is what `src/run.py --exp` writes:
    audio/<id>.wav            edited audio (required)
    predictions.json          optional — used only to find the output file if audio/<id>.wav is missing
    traces/<id>.json          optional — tool steps and changed_spans
    scores/per_sample.json    optional — IFR / CR / EM per sample
    scores/results.jsonl      optional — the judge's answer per rubric

Source audio is looked up by id in the MMAE dataset (data/MMAE_data/wav/<id>/audioN.wav),
so the absolute server paths inside predictions.json / traces are never used.
"""

from __future__ import annotations

import argparse
import csv
import json
import mimetypes
import os
import re
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from math import gcd
from urllib.parse import unquote, urlparse

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATA = os.path.join(HERE, "data", "MMAE_data")
DEFAULT_META_DIR = os.path.join(HERE, "data", "meta")
STATIC = os.path.join(HERE, "static")

# ---- metrics ---------------------------------------------------------------------------
SR = 16000          # everything is compared as mono 16 kHz
N_FFT = 512
HOP = 160           # 10 ms frames
CURVE_POINTS = 600  # change curve sent to the browser is resampled to this many points


def load_mono16k(path: str) -> tuple[np.ndarray, dict]:
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    info = {"sr": sr, "channels": x.shape[1], "duration": x.shape[0] / sr if sr else 0.0}
    x = x.mean(axis=1)
    if sr != SR and len(x):
        g = gcd(sr, SR)
        x = resample_poly(x, SR // g, sr // g).astype(np.float32)
    return x, info


def db(v: float) -> float | None:
    return None if v <= 1e-10 else round(20 * np.log10(v), 2)


def log_spec(x: np.ndarray) -> np.ndarray:
    """(frames, bins) log power in dB."""
    if len(x) < N_FFT:
        x = np.pad(x, (0, N_FFT - len(x)))
    n = 1 + (len(x) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n)[:, None]
    frames = x[idx] * np.hanning(N_FFT).astype(np.float32)
    p = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    return 10 * np.log10(np.maximum(p, 1e-10))


def compare(src_path: str, out_path: str) -> dict:
    a, ia = load_mono16k(src_path)
    b, ib = load_mono16k(out_path)
    m: dict = {
        "src_duration": round(ia["duration"], 3), "src_sr": ia["sr"], "src_channels": ia["channels"],
        "out_duration": round(ib["duration"], 3), "out_sr": ib["sr"], "out_channels": ib["channels"],
        "duration_delta": round(ib["duration"] - ia["duration"], 3),
        "src_rms_db": db(float(np.sqrt(np.mean(a ** 2)))) if len(a) else None,
        "out_rms_db": db(float(np.sqrt(np.mean(b ** 2)))) if len(b) else None,
        "out_peak_db": db(float(np.max(np.abs(b)))) if len(b) else None,
        "out_clip_pct": round(100 * float(np.mean(np.abs(b) >= 0.999)), 3) if len(b) else 0.0,
    }
    if m["src_rms_db"] is not None and m["out_rms_db"] is not None:
        m["rms_delta_db"] = round(m["out_rms_db"] - m["src_rms_db"], 2)
    else:
        m["rms_delta_db"] = None

    n = min(len(a), len(b))
    if n >= N_FFT:
        aa, bb = a[:n], b[:n]
        sa, sb = aa.std(), bb.std()
        m["corr"] = round(float(np.mean((aa - aa.mean()) * (bb - bb.mean())) / (sa * sb)), 4) if sa > 0 and sb > 0 else None
        # Frames where both are digital silence would give 0 distance anyway; the floor keeps
        # near-silent frames from dominating.
        la, lb = log_spec(aa), log_spec(bb)
        d = np.sqrt(np.mean((np.maximum(lb, -80) - np.maximum(la, -80)) ** 2, axis=1))  # per-frame LSD
        m["lsd_db"] = round(float(d.mean()), 2)
        m["changed_pct"] = round(100 * float(np.mean(d > 6.0)), 1)   # frames that differ by > 6 dB
        xs = np.linspace(0, len(d) - 1, min(CURVE_POINTS, len(d)))
        curve = np.interp(xs, np.arange(len(d)), d)
        m["_curve"] = {"seconds": round(n / SR, 3), "values": [round(float(v), 2) for v in curve]}
    else:
        m["corr"] = m["lsd_db"] = m["changed_pct"] = None

    flags = []
    if m["out_rms_db"] is None or m["out_rms_db"] < -60:
        flags.append("silent")
    if m["lsd_db"] is not None and m["lsd_db"] < 0.5 and abs(m["duration_delta"]) < 0.01:
        flags.append("unchanged")
    if m["out_clip_pct"] > 0.1:
        flags.append("clipping")
    if abs(m["duration_delta"]) > 0.05:
        flags.append("length")
    m["flags"] = flags
    return m


# ---- dataset + run ---------------------------------------------------------------------
AUDIO_TAG = re.compile(r"<audio (\w+)(?:\[[^\]]*\])?>")


def load_meta(paths: list[str]) -> dict:
    meta = {}
    for p in paths:
        with open(p, encoding="utf-8") as f:
            for e in json.load(f):
                e["_split"] = os.path.basename(p).replace("MMAE-meta-", "").replace(".json", "")
                meta[e["id"]] = e
    return meta


def read_json(path: str, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


class Run:
    def __init__(self, out_dir: str, data_dir: str, meta: dict):
        self.out_dir = os.path.abspath(out_dir)
        self.data_dir = os.path.abspath(data_dir)
        self.meta = meta
        self.name = os.path.basename(self.out_dir.rstrip("/"))

        audio_dir = os.path.join(self.out_dir, "audio")
        self.outputs: dict[str, str] = {}
        if os.path.isdir(audio_dir):
            for f in os.listdir(audio_dir):
                if f.endswith(".wav"):
                    self.outputs[f[:-4]] = os.path.join(audio_dir, f)
        # predictions.json can point at a file under another name; keep only what exists here.
        for p in read_json(os.path.join(self.out_dir, "predictions.json"), []) or []:
            sid = p.get("id")
            if sid in self.outputs:
                continue
            for msg in p.get("messages", []):
                if msg.get("role") != "assistant":
                    continue
                for c in msg.get("content", []):
                    if c.get("type") == "audio":
                        cand = os.path.join(audio_dir, os.path.basename(c.get("audio_url", "")))
                        if os.path.isfile(cand):
                            self.outputs[sid] = cand

        self.ids = sorted(set(self.outputs) | {
            p.get("id") for p in (read_json(os.path.join(self.out_dir, "predictions.json"), []) or [])
            if p.get("id")
        })

        self.scores = {r["sample_id"]: r for r in read_json(os.path.join(self.out_dir, "scores", "per_sample.json"), []) or []}
        self.judge: dict[str, dict[str, dict]] = {}
        rpath = os.path.join(self.out_dir, "scores", "results.jsonl")
        if os.path.isfile(rpath):
            with open(rpath, encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        r = json.loads(line)
                        self.judge.setdefault(r["sample_id"], {})[r.get("rubric_id", "")] = r

        self.metrics: dict[str, dict] = {}
        self.metrics_errors: dict[str, str] = {}
        self.missing_sources: set[str] = set()

    # sources ---------------------------------------------------------------------------
    def sources(self, sid: str) -> list[dict]:
        """[{name: 'input1', rel: 'wav/<id>/audio1.wav', exists}] in the order the meta mentions them."""
        e = self.meta.get(sid)
        rels: list[str] = []
        if e:
            for msg in e.get("messages", []):
                for c in msg.get("content", []):
                    if c.get("type") == "audio" and c.get("audio_url") and c["audio_url"] not in rels:
                        rels.append(c["audio_url"])
        else:
            d = os.path.join(self.data_dir, "wav", sid)
            if os.path.isdir(d):
                rels = [f"wav/{sid}/{f}" for f in sorted(os.listdir(d)) if f.endswith(".wav")]
        out = []
        for rel in rels:
            m = re.search(r"audio(\d+)\.wav$", rel)
            name = f"input{m.group(1)}" if m else os.path.basename(rel)
            out.append({"name": name, "rel": rel, "exists": os.path.isfile(os.path.join(self.data_dir, rel))})
        return out

    def instructions(self, sid: str) -> list[str]:
        e = self.meta.get(sid)
        if not e:
            t = read_json(os.path.join(self.out_dir, "traces", f"{sid}.json"), {}) or {}
            return [t["instruction"]] if t.get("instruction") else []
        return [c["text"] for msg in e.get("messages", []) if msg.get("role") == "user"
                for c in msg.get("content", []) if c.get("type") == "text"]

    # metrics ---------------------------------------------------------------------------
    def compute_metrics(self, sid: str) -> dict | None:
        if sid in self.metrics:
            return self.metrics[sid]
        out = self.outputs.get(sid)
        srcs = [s for s in self.sources(sid) if s["exists"]]
        if not out or not srcs:
            if not srcs:
                self.missing_sources.add(sid)
            return None
        try:
            m = compare(os.path.join(self.data_dir, srcs[0]["rel"]), out)
        except Exception as exc:  # unreadable / empty wav — show it, don't stop the batch
            self.metrics_errors[sid] = f"{type(exc).__name__}: {exc}"
            return None
        self.metrics[sid] = m
        return m

    def compute_all(self, progress=None):
        for i, sid in enumerate(self.ids):
            self.compute_metrics(sid)
            if progress:
                progress(i + 1, len(self.ids))

    # API payloads ----------------------------------------------------------------------
    def summary_row(self, sid: str) -> dict:
        e = self.meta.get(sid, {})
        sc = self.scores.get(sid, {})
        m = self.metrics.get(sid)
        ins = self.instructions(sid)
        return {
            "id": sid,
            "instruction": ins[0] if ins else "",
            "n_instructions": len(ins),
            "modality": e.get("modality", sc.get("modality", "")),
            "complexity": e.get("complexity", sc.get("complexity", "")),
            "split": e.get("_split", ""),
            "has_output": sid in self.outputs,
            "ifr": sc.get("instruction_following"),
            "cr": sc.get("consistency"),
            "em": sc.get("exact_match"),
            "metrics": {k: v for k, v in m.items() if not k.startswith("_")} if m else None,
            "metrics_error": self.metrics_errors.get(sid),
        }

    def detail(self, sid: str) -> dict:
        e = self.meta.get(sid, {})
        judged = self.judge.get(sid, {})
        rubrics = []
        for i, r in enumerate(e.get("rubrics", []), 1):
            j = judged.get(f"R{i}")
            if j is None:  # fall back to matching by question text
                j = next((v for v in judged.values() if v.get("question") == r.get("question")), None)
            rubrics.append({
                **r,
                "score": j.get("score") if j else None,
                "scores": j.get("scores") if j else None,
                "judge_reason": _judge_reason(j) if j else None,
                "judge_choice": _judge_choice(j) if j else None,
            })
        trace = read_json(os.path.join(self.out_dir, "traces", f"{sid}.json"))
        m = self.compute_metrics(sid)
        return {
            **self.summary_row(sid),
            "instructions": self.instructions(sid),
            "operations": e.get("operations", []),
            "tags": e.get("tags", []),
            "sources": [{"name": s["name"], "exists": s["exists"], "url": "/audio/src/" + s["rel"]} for s in self.sources(sid)],
            "output_url": f"/audio/out/{sid}" if sid in self.outputs else None,
            "curve": m.get("_curve") if m else None,
            "rubrics": rubrics,
            "trace": _trace_summary(trace) if trace else None,
        }


def _judge_reason(j: dict) -> str | None:
    for a in j.get("attempts_detail") or []:
        raw = a.get("raw_response") or ""
        try:
            return json.loads(raw).get("reason")
        except (ValueError, AttributeError):
            if raw:
                return raw[:600]
    return None


def _judge_choice(j: dict) -> str | None:
    for a in j.get("attempts_detail") or []:
        letter = a.get("model_choice")
        for c in a.get("choices") or []:
            if letter and c.startswith(letter + "."):
                return c[len(letter) + 1:].strip()
    return None


def _short(v, limit=400) -> str:
    s = json.dumps(v, ensure_ascii=False)
    return s if len(s) <= limit else s[:limit] + " …"


def _trace_summary(t: dict) -> dict:
    steps = []
    for s in t.get("steps", []):
        stage = s.get("stage")
        if stage == "tool":
            item = {"step": s.get("step"), "tool": s.get("tool"), "args": _short(s.get("args", {}), 300)}
            if "error" in s:
                item["error"] = str(s["error"])[:400]
            elif "result" in s:
                item["result"] = _short(s["result"])
            if s.get("changed_spans"):
                item["changed_spans"] = s["changed_spans"]
            if s.get("note"):
                item["note"] = str(s["note"])[:300]
            steps.append(item)
        elif stage == "finish":
            steps.append({"tool": "finish"})
        else:
            steps.append({"tool": stage, "result": str(s.get("content", ""))[:600]})
    return {
        "steps": steps,
        "changed_spans": t.get("changed_spans") or [],
        "error": t.get("error"),
        "fallback_used": t.get("fallback_used"),
        "budget_hit": t.get("budget_hit"),
        "preserve": t.get("preserve"),
        "wall_seconds": (t.get("timing") or {}).get("wall_seconds"),
    }


# ---- HTTP ------------------------------------------------------------------------------
def make_handler(run: Run, state: dict):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _file(self, path: str):
            """Serve a file with Range support (Safari needs it to seek audio)."""
            if not os.path.isfile(path):
                return self.send_error(HTTPStatus.NOT_FOUND)
            size = os.path.getsize(path)
            ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
            start, end = 0, size - 1
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                a, _, b = rng[6:].split(",")[0].partition("-")
                if a:
                    start = int(a)
                    end = int(b) if b else end
                elif b:
                    start = max(0, size - int(b))
                end = min(end, size - 1)
                if start > end:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{size}")
                    return self.end_headers()
                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 16, left))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    left -= len(chunk)

        def do_GET(self):
            path = unquote(urlparse(self.path).path)
            if path in ("/", "/index.html"):
                return self._file(os.path.join(STATIC, "index.html"))
            if path.startswith("/static/"):
                p = os.path.normpath(os.path.join(STATIC, path[len("/static/"):]))
                return self._file(p) if p.startswith(STATIC + os.sep) else self.send_error(403)
            if path == "/api/run":
                return self._json({
                    "name": run.name, "out_dir": run.out_dir, "data_dir": run.data_dir,
                    "n": len(run.ids), "has_scores": bool(run.scores),
                    "progress": state["progress"],
                    "missing_sources": len(run.missing_sources),
                })
            if path == "/api/samples":
                return self._json({"progress": state["progress"], "samples": [run.summary_row(s) for s in run.ids]})
            if path.startswith("/api/sample/"):
                sid = path.rsplit("/", 1)[-1]
                if sid not in run.ids:
                    return self._json({"error": "unknown id"}, 404)
                return self._json(run.detail(sid))
            if path.startswith("/audio/out/"):
                sid = path.rsplit("/", 1)[-1]
                return self._file(run.outputs.get(sid, ""))
            if path.startswith("/audio/src/"):
                p = os.path.normpath(os.path.join(run.data_dir, path[len("/audio/src/"):]))
                return self._file(p) if p.startswith(run.data_dir + os.sep) else self.send_error(403)
            self.send_error(HTTPStatus.NOT_FOUND)

    return Handler


# ---- CLI -------------------------------------------------------------------------------
CSV_FIELDS = ["id", "split", "modality", "complexity", "ifr", "cr", "em", "flags",
              "src_duration", "out_duration", "duration_delta", "src_sr", "out_sr",
              "src_rms_db", "out_rms_db", "rms_delta_db", "out_peak_db", "out_clip_pct",
              "corr", "lsd_db", "changed_pct", "instruction"]


def write_csv(run: Run, path: str):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for sid in run.ids:
            r = run.summary_row(sid)
            m = r.pop("metrics") or {}
            row = {**r, **m, "flags": " ".join(m.get("flags", []))}
            w.writerow({k: row.get(k) for k in CSV_FIELDS})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("output_dir", help="run directory (contains audio/<id>.wav)")
    ap.add_argument("--data", default=DEFAULT_DATA, help="MMAE audio root containing wav/ (default: %(default)s)")
    ap.add_argument("--meta", nargs="*", help="MMAE meta JSON file(s) (default: data/meta/*.json)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--csv", metavar="PATH", help="write per-sample metrics to a CSV and exit")
    args = ap.parse_args()

    if not os.path.isdir(os.path.join(args.output_dir, "audio")):
        sys.exit(f"no audio/ folder in {args.output_dir}")
    if not os.path.isdir(os.path.join(args.data, "wav")):
        sys.exit(f"MMAE audio not found at {args.data}/wav — run: .venv/bin/python download_data.py")
    metas = args.meta or sorted(
        os.path.join(DEFAULT_META_DIR, f) for f in os.listdir(DEFAULT_META_DIR) if f.endswith(".json"))
    run = Run(args.output_dir, args.data, load_meta(metas))
    print(f"{run.name}: {len(run.ids)} samples, {len(run.outputs)} output files, {len(run.scores)} scored")

    if args.csv:
        def prog(i, n):
            print(f"\r  metrics {i}/{n}", end="", file=sys.stderr, flush=True)
        run.compute_all(prog)
        print(file=sys.stderr)
        write_csv(run, args.csv)
        if run.missing_sources:
            print(f"  {len(run.missing_sources)} samples have no source audio in {args.data}")
        for sid, err in run.metrics_errors.items():
            print(f"  {sid}: {err}")
        print(f"wrote {args.csv}")
        return

    state = {"progress": [0, len(run.ids)]}

    def prog(i, n):
        state["progress"] = [i, n]
    threading.Thread(target=run.compute_all, args=(prog,), daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(run, state))
    url = f"http://127.0.0.1:{args.port}/"
    print(f"open {url}   (Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
