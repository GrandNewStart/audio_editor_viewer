# MMAE instruction → action sequences

`mmae_action_sequences.csv` pairs each of the 2,000 MMAE instructions
(`data/MMAE_data/metadata.csv`, same row order) with a plausible sequence of actions.
These labels are a planning aid: one reasonable route per instruction, chosen by hand.
They are not ground truth.

Columns: `index, id, complexity, modality, num_audios, instruction, actions, n_steps,
uses_dsp, uses_separate, uses_generate, uses_gensound, uses_custom`. The CSV is UTF-8 with BOM, so Excel
opens the Korean and Chinese text correctly.

## Action vocabulary

| action | meaning |
|---|---|
| `DSP-<op>` | an op that already exists in `Audio_editor/src/tools/dsp.py`: volume, speed, pitch, cut, mute, insert, mix, repeat, stretch_span, reverb, eq, fade, normalize, reverse |
| `Separate` | SAM-Audio: extract a source (target) or remove it (residual) |
| `Generate` | AuK `generative_edit`, used where the repo's own tool description puts it: change words, voice, emotion or speaking style, accent, denoise, re-synthesize a part. This label also covers instrument, genre and mode changes that keep the melody |
| `GenSound` | TangoFlux `generate_sound` (`src/tools/t2a.py`): new sound content from a text prompt (a dog bark, music, ambience) |
| `Custom-<job>` | anything the four above can't do |

Format: `A → B → C` is one round. Multi-round tasks look like `R1: … \| R2: …`.

Conventions:
- **One source louder or softer** is `Separate → DSP-volume → Custom-mix` (isolate, change the gain, mix back).
- **`DSP-mix` and `DSP-insert` only when the material is another input file.** `dsp.py`'s
  `mix`/`insert` take a second input audio. Overlaying a separated stem, a generated sound,
  or a segment of the same audio is `Custom-mix` / `Custom-insert`.
- **New sound content** (adding a dog bark, music, ambience) is `GenSound → Custom-mix` (or
  `→ Custom-insert` when it goes into a gap). Speech with given words is `Custom-tts`, not `GenSound`.
- **Replacing sound X with Y** is `Separate → GenSound → Custom-mix`. **The same events
  with a new texture** (e.g. "make the footsteps sound like dry leaves") is `Generate`.
- **"Undo" rounds** that just return to the original input are `Custom-revert`.
- **Perception steps** (transcribe, detect events, find the span) aren't listed. They're assumed
  wherever a span is needed.

## Summary (2,000 instructions)

| family | instructions using it |
|---|---:|
| Separate | 1,069 (53%) |
| Custom | 973 (49%) |
| DSP | 572 (29%) |
| Generate | 474 (24%) |
| GenSound | 365 (18%) |

Most common combinations: Separate only 409 · Generate only 329 · DSP only 189 ·
DSP+Separate+Custom 189 · Custom only 167 · Separate+Custom 142 · Separate+GenSound+Custom 140 ·
GenSound+Custom 138.

`GenSound` almost never stands alone (1 of 365): the generated clip still has to be overlaid
or inserted, so 364 of them also need `Custom-mix` or `Custom-insert`. That is why splitting it
out barely moves the Custom count (974 → 973).

DSP ops by instruction count: volume 209 · cut 95 · speed 85 · pitch 38 · eq 37 · mute 31 ·
insert 30 · reverb 27 · mix 24 · fade 22 · stretch_span 13 · repeat 7 · normalize 2 · reverse 2.

### What "Custom" really is

`Custom-mix` alone accounts for most of it, and it is a small gap:

| Custom job | instructions | what closes it |
|---|---:|---|
| `Custom-mix` | 707 | let `mix` accept an internal stem or generated audio, not only a second input file |
| `Custom-insert` | 66 | same change as `mix`, for `insert` |
| `Custom-revert` | 45 | output the round's input unchanged |
| `Custom-reorder` | 41 | cut + insert of segments from the same audio (swap or move events) |
| `Custom-beep` / `insert_silence` / `loop` / `layer_copies` / `crossfade` | 35 | simple signal ops |

With those small extensions, **1,693 of 2,000 instructions (85%)** need only existing tools.
The remaining 307 need genuinely new capability (counts are instructions per job; one instruction can need several):

| new capability | count | examples |
|---|---:|---|
| `voice_conversion` (timbre from a reference audio) | 66 | "use the voice from audio2 to speak audio1" |
| `tts` / `voice_clone_tts` (new speech with given words) | 40 | "add a man saying 'Oh you are so cute'" |
| `accompaniment_generation` / `singing_generation` / `harmonize` | 41 | add drums or guitar that follow the rhythm, harmony a third above |
| `speech_translation` (keep the voice) | 21 | dialect → Mandarin, Korean → English |
| `dereverb` | 19 | "remove the reverb of the solo" |
| `singing_edit` (change lyrics, keep the melody) | 17 | lyric replacement in songs |
| `add_noise` (crackle, static, white noise) | 13 | gramophone / lo-fi |
| `style_transfer` / `timbre_transfer` (from a reference audio) | 24 | "play audio1's melody with audio2's timbre" |
| `retime_events` / `time_align` / `time_warp` / `rhythm_edit` | 19 | space out events, steady the tempo, swing feel |
| `sample_replace` (trigger a sample at each hit) | 7 | replace the kick drum with thunder |
| `inpaint` (generate missing or bridging audio) | 7 | fill a gap between two clips |
| other (prosody_transfer, bandwidth_extension, distortion, speech_to_singing/rap, …) | 44 | `add_chord_tone`, `doppler`, `sidechain`, `formant_shift`, `bandwidth_extension`, … |

## Files

- `mmae_action_sequences.csv`: the result
- `_labels/*.txt`: the raw labels in shorthand (`S`, `G`, `GS`, `D:op`, `C:job`, `>` for then, `||` for a new round)
- `_build.py`: rebuilds the CSV from `_labels/` and checks that every row is covered and every DSP op exists
- `_stats.json`: the counts above
