# audio-editor-viewer

Audio_editor 실행 결과(편집된 오디오)를 MMAE 원본 오디오와 나란히 놓고 비교하는 뷰어다.

```bash
.venv/bin/python compare.py runs/val_fixed                  # 브라우저에서 뷰어를 연다
.venv/bin/python compare.py runs/val_fixed --csv m.csv      # UI 없이 샘플별 지표만 CSV 로
```

옵션: `--port 8765`, `--no-browser`, `--data <wav/ 가 있는 MMAE 루트>`, `--meta <meta json …>`.

## 설치

Python 3.10 이상이 필요하다.

```bash
git clone <이 저장소> audio-editor-viewer && cd audio-editor-viewer
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python download_data.py      # MMAE 오디오 ~5.2GB -> data/MMAE_data/wav/<id>/audioN.wav
```

`download_data.py` 는 Hugging Face 데이터셋 `BoJack/MMAE` 에서 받는다. 다시 실행하면 이어 받고,
이미 있는 파일은 건너뛴다.

`data/meta/` 에는 MMAE 메타(train/val/test, 전체 2,000 샘플)가 들어 있다. `Audio_editor/splits/` 에서
복사한 것이고, 샘플마다 지시문, 원본 파일, 루브릭을 담고 있다.

## 실행 결과 폴더 놓기

뷰어에 넘기는 것은 Audio_editor 의 `src/run.py --exp <이름>` (또는 `src/run_v2.py`) 가 만든
**실행 폴더 하나**다. 이 폴더는 저장소에 들어 있지 않으므로 GPU 서버에서 직접 가져와야 한다.

**어디에 두나:** 경로는 인자로 넘기므로 어디에 둬도 된다. 정해 두자면 이 폴더 안의 `runs/<실행 이름>/`
에 둔다. `runs/` 는 `.gitignore` 에 들어 있어 커밋되지 않는다.

```bash
# GPU 서버의 Audio_editor/outputs/val_fixed 를 runs/val_fixed 로 가져오기 (logs/ 는 필요 없다)
rsync -av --exclude logs/ <user>@<gpu-server>:<Audio_editor 경로>/outputs/val_fixed/ runs/val_fixed/
.venv/bin/python compare.py runs/val_fixed
```

**구조:** `audio/` 만 있으면 된다. 나머지는 있으면 해당 정보가 뷰어에 더 나온다.

```
runs/val_fixed/
├── audio/
│   └── <id>.wav              필수. 편집된 오디오. 파일 이름이 MMAE 샘플 id 다
├── predictions.json          선택. audio/<id>.wav 가 없을 때 출력 파일 이름을 찾는 데만 쓴다
├── traces/
│   └── <id>.json             선택. 에이전트 단계, 오류, changed_spans (트랙 위 주황 띠)
└── scores/                   선택. score.sh 가 만든다
    ├── per_sample.json       IFR / CR / EM 칩과 정렬
    └── results.jsonl         루브릭별 judge 판정, 투표, 이유
```

- `<id>` 는 `69e897fbf1844435bec75ef4` 같은 MMAE 샘플 id 다. 지시문과 루브릭은 이 id 로 `data/meta/` 에서 찾는다.
- 원본 오디오는 샘플 id 로 `data/MMAE_data` 에서 찾는다. 그래서 `predictions.json` 이나 trace 에 적힌
  서버의 절대 경로는 상관없다.
- 채점 전의 실행이면 `scores/` 없이 열면 된다. 지표와 파형 비교는 그대로 나온다.

## 뷰어

- 각 원본(`input1`, 여러 오디오 샘플이면 `input2`/`input3`)과 출력이 파형과 로그 주파수 스펙트로그램으로
  **같은 시간축**, 같은 절대 dB 눈금에 그려진다. 위치와 크기를 그대로 비교할 수 있다.
- 출력 아래 띠는 **`input1` 과 어디가 다른지**를 보여 준다. 10ms 마다의 log-spectral distance 를
  0초부터 맞춰 그린 것이고, 점선이 6dB 다. 출력 길이가 바뀌었으면 첫 편집 뒤로는 전부 밀려 있으니
  그걸 감안해서 읽는다.
- 루브릭의 `▶ output[2.7s:4.7s]` 칩은 그 오디오의 그 구간만 재생한다.
- 단축키: `Space` 재생/정지 · `A` / `B` 원본 / 출력으로 **같은 시간 위치에서** 전환 ·
  `←` `→` 1초 이동 · `J` / `K` 다음 / 이전 샘플 · `/` 필터.
- 필터: 모달리티, 플래그, EM. 정렬: IFR, CR, 변화량, 길이 변화.

## 지표 (모노 16kHz, 출력 vs `input1`)

| 지표 | 뜻 |
|---|---|
| `duration_delta` | 출력 − 원본, 초 |
| `rms_delta_db` | 전체 음량 변화 |
| `corr` | 겹치는 구간의 파형 상관 (1 = 같음) |
| `lsd_db` | 평균 log-spectral distance (0 = 변화 없음) |
| `changed_pct` | 6dB 넘게 달라진 10ms 프레임 비율 (%) |

플래그: `silent` (출력 RMS < −60 dBFS) · `unchanged` (LSD < 0.5dB, 길이 같음) ·
`clipping` (샘플의 0.1% 넘게 최대치) · `length` (|길이 차| > 50ms).

## 그 밖의 파일

`results/` 에는 MMAE 지시문 2,000개 각각에 붙인 액션 시퀀스 라벨이 있다
(`mmae_action_sequences.csv`). 자세한 내용은 `results/README.md` 를 본다.
