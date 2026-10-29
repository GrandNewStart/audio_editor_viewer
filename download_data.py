#!/usr/bin/env python3
"""Download the MMAE audio (Hugging Face dataset BoJack/MMAE, ~5.5 GB) into data/MMAE_data/.

    .venv/bin/python download_data.py

Re-running resumes and skips files that are already there.
"""
import os

from huggingface_hub import snapshot_download

HERE = os.path.dirname(os.path.abspath(__file__))
path = snapshot_download(
    "BoJack/MMAE",
    repo_type="dataset",
    allow_patterns=["wav/**", "README.md", "metadata.csv"],
    local_dir=os.path.join(HERE, "data", "MMAE_data"),
    max_workers=8,
)
n = sum(len(fs) for _, _, fs in os.walk(os.path.join(path, "wav")))
print(f"done: {n} files in {path}/wav")
