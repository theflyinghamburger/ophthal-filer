# Ophthalmic Dictation → Structured Chart

**Local-first speech-to-chart pipeline for an ophthalmology practice.**

Status: architecture + PoC plan, **v2** (2026-09-20) — revised after architecture review
Target: TypeScript / Electron / Windows x64
Deployment: single clinic workstation, fully offline

---

## 0. TL;DR

Record a dictation → clean audio → Parakeet ASR → **LLM repairs the transcript using a retrieved ophthalmology glossary** → expand laterality shorthand → sectioned, grammar-constrained extraction → validate → **doctor reviews** → fill a real fillable AcroForm PDF.

Four decisions carry the design:

1. **One lexicon, four consumers.** A single `lexicon/ophthalmology.json` generates the ASR hotword list, the phonetic retrieval index, the LLM repair glossary, and the validator's term whitelist. Terms are the project's central domain asset; they get one home.
2. **The transcript is raw text plus an ordered edit list, never a rewritten string.** Every correction — LLM or deterministic — is a verbatim-anchored replacement. This preserves the mapping back to audio timestamps, makes every change auditable and reversible, and feeds the learning loop for free.
3. **The LLM extracts, it never infers.** Every field nullable, grammar forces `null` for anything not said, every populated field carries a verbatim evidence span. Confidence is *computed* from verifiable signals, never self-reported by the model.
4. **Human review is a pipeline stage.** The output is an AI-assisted draft. The doctor signs it.

Build the PoC as a **headless CLI**. Electron wrapping is a day at the end.

---

## 1. What changed from v1

If you read v1, these are the substantive revisions.

| # | Change | Why |
|---|---|---|
| 1 | **Two LLM passes** — repair, then extract | Parakeet will mangle Indian-accented ophthalmic speech. Contextual repair is a distinct job from slot-filling, and small models do better at one thing at a time. |
| 2 | **Glossary retrieved phonetically, not dumped** | An 800-term glossary is ~12k tokens and would swamp a 4B's context. ASR errors are *phonetic* errors, so Double Metaphone retrieval of ~50 candidate terms is both cheaper and better-targeted. |
| 3 | **Transcript = raw + anchored edits** | v1 had a design hole: regex normalization destroyed the offset mapping the review UI needed to scrub audio. Anchored edits fix it and make LLM repair auditable. |
| 4 | **Self-reported confidence removed** | Small models are badly calibrated on introspective confidence. Replaced with computed signals: evidence-span validity, decision-point logprobs, validation outcome, repair overlap. |
| 5 | **Laterality expansion is its own stage** | "Cornea clear OU", "OS same except…" is how people actually dictate. v1 had no handling at all. |
| 6 | **Eval harness moved from step 9 to step 3** | You cannot iterate on prompts without a scoring harness. v1 scheduled the instrument after the work it measures. |
| 7 | **PDF: scan-as-background + real AcroForm fields** | v1 posed a false dichotomy between vector rebuild and coordinate overlay. The hybrid gives pixel fidelity *and* real fields, at a third of the effort. |
| 8 | **Prompt ordering inverted** | `cache_prompt` in llama.cpp is explicitly prefix-based. Section instructions must come *after* the transcript for the six extraction calls to share a cache. |
| 9 | Minus-cyl: flag, never convert | Transposing cylinder is a clinical transformation, not validation. |
| 10 | Timeline restated as 4–6 weeks calendar | v1's 11–14 days was effort, ignoring clinician availability and unbounded prompt iteration. |

---

## 2. Hardware reality check

**Acer Predator Helios 300** spans six generations with very different GPUs:

| Model year | Chassis | GPU | VRAM |
|---|---|---|---|
| 2017 | G3-571/572 | GTX 1050 Ti / 1060 | 4–6 GB |
| 2018 | PH315-51 | GTX 1060 | 6 GB |
| 2019 | PH315-52 | GTX 1660 Ti / RTX 2060 | 6 GB |
| 2020 | PH315-53 | RTX 2060 / 2070 | 6–8 GB |
| 2021 | PH315-54 | RTX 3060 / 3070 / 3080 | 6–8 GB |
| 2022 | PH315-55, PH317-56 | RTX 3060 / 3070 Ti | 6–8 GB |

Confirm before sizing anything:

```powershell
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
wmic csproduct get name
```

**Plan for 6 GB VRAM, 16 GB system RAM.**

### Compute budget (revised for two passes)

| Stage | Device | Cost |
|---|---|---|
| Audio preprocess | CPU | ~0.01× realtime |
| Parakeet ASR int8 | **CPU** | ~0.05–0.15× realtime |
| Glossary retrieval | CPU | <50 ms |
| **Pass A — repair** | GPU | ~3–8 s |
| **Laterality expansion** | GPU | ~1–3 s |
| **Pass B — 6 extraction calls** | GPU | ~6–15 s |
| Validate + PDF | CPU | <200 ms |

**Realistic end-to-end for a 3-minute dictation: 25–45 s.** v1's "<30 s" was optimistic; two passes cost real time. Measure before promising a number to the doctor.

**Keep ASR on CPU**, and **never run ASR and the LLM concurrently** — the pipeline is sequential anyway, and on a 6-core laptop overlapping them thrashes. Make that explicit in code so nobody "optimizes" it later.

**One model, loaded once.** Do not try to hold two models on a 6 GB card. Pass A, laterality, and Pass B all use the same weights with different prompts and grammars.

---

## 3. Component choices

### 3.1 Speech-to-text — sherpa-onnx + Parakeet

**Package:** `sherpa-onnx-node` (v1.13.8). Prebuilt N-API addon, no Python, no build toolchain. Platform binaries ship as optional deps: `sherpa-onnx-win-x64`, `sherpa-onnx-linux-x64`, `sherpa-onnx-darwin-arm64`. Node ≥ 16.

**Model:** `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` — English, offline transducer, ~630 MB.

```
https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2
```

> **Accent expectation, set honestly.** Parakeet is trained predominantly on US/EU English. On Indian-accented ophthalmic dictation, expect meaningful degradation on exactly the clinical vocabulary that matters. **This is designed for, not hoped away** — §5.4 exists because of it. But still run the bake-off in Step 4: if Parakeet's raw output is so mangled that repair can't recover it, switch to `whisper-large-v3-turbo` int8 via the same sherpa-onnx runtime. Repair fixes phonetically-close errors; it cannot fix a transcript that lost the signal.

**Decoding with hotwords** — contextual biasing is the cheapest accuracy you will ever buy, and it happens *before* the LLM ever sees the text:

```ts
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder, decoder, joiner },
    tokens,
    numThreads: 4,
    provider: 'cpu',
    modelType: 'nemo_transducer',
  },
  decodingMethod: 'modified_beam_search',   // required for hotwords
  maxActivePaths: 4,
  hotwordsFile: 'build/hotwords.txt',       // generated from the lexicon
  hotwordsScore: 2.0,
});
```

Also request per-token scores — they feed the ASR quality gate (§5.2).

### 3.2 The lexicon — one artifact, four consumers

This is the project's central domain asset and the thing most worth your friend's time.

```jsonc
// lexicon/ophthalmology.json
{
  "terms": [
    {
      "term": "pseudophakia",
      "aliases": ["pseudophakic", "PCIOL", "posterior chamber IOL"],
      "spoken": ["sudo fake ia", "pseudo fakia"],   // observed ASR manglings
      "gloss": "Eye with an implanted intraocular lens after cataract surgery.",
      "sections": ["od.anterior.lensMedia", "os.anterior.lensMedia"],
      "boost": 2.5
    },
    {
      "term": "Shafer's sign",
      "aliases": ["tobacco dust", "pigment in anterior vitreous"],
      "spoken": ["shaffer sign", "schafer sign"],
      "gloss": "Pigment cells in the anterior vitreous; suggests retinal break.",
      "sections": ["od.posterior.media", "os.posterior.media"],
      "boost": 3.0
    }
  ]
}
```

Four generated artefacts, one source:

```
lexicon/ophthalmology.json
   ├─→ build/hotwords.txt         sherpa-onnx contextual biasing (term + aliases + boost)
   ├─→ build/phonetic-index.json  Double Metaphone keys → term ids (Pass A retrieval)
   ├─→ Pass A glossary injection  term + gloss, for the ~50 retrieved candidates
   └─→ validator term whitelist   "is this a real ophthalmic term?"
```

The `sections` field is a prior, not a constraint — it lets retrieval weight terms that plausibly belong to the section being processed, and later lets the validator raise an eyebrow at "trabeculectomy" appearing in a lids/lashes field.

`spoken` starts empty and **fills itself from the learning loop** (§5.9). That's the compounding asset.

### 3.3 Local LLM — llama.cpp `llama-server`

Run `llama-server` as a managed child process on `127.0.0.1`, random port, random per-launch `--api-key`. OpenAI-compatible HTTP API.

**Why the subprocess over `node-llama-cpp`:** no native rebuild coupled to your Electron ABI; swapping a CPU build for CUDA or Vulkan is a file swap; server-side prompt caching; `response_format: { type: "json_schema" }` and raw GBNF `grammar` are both first-class; and the same interface points at a cloud endpoint later without touching extraction code. Cost is ~80 lines of process lifecycle management.

**Two server capabilities the design leans on**, both confirmed in the server README:

- **`cache_prompt`** — *"Re-use KV cache from a previous request if possible. This way the common prefix does not have to be re-processed, only the suffix that differs between the requests."* Explicitly **prefix-based**. See §5.6 for the prompt-ordering consequence. Note the documented caveat that it "can cause nondeterministic results" across batch sizes — acceptable here, but don't build exact-reproducibility promises on top of it.
- **`n_probs` / `logprobs`** — *"If greater than 0, the response also contains the probabilities of top N tokens for each generated token."* Returns a `completion_probabilities` array with `top_logprobs`. This replaces self-reported confidence (§6.2). `post_sampling_probs` gives post-sampling-chain probabilities as plain 0–1 values if you prefer those.

#### Model recommendation

| Model | Q4_K_M | Fits 6 GB? | Verdict |
|---|---|---|---|
| **Qwen3-8B** | ~4.9 GB | Tight, 4–6k ctx | **Primary.** Best structured extraction in class. |
| **Qwen3-4B-Instruct-2507** | ~2.5 GB | Comfortably, 16k ctx | **Fallback / low-VRAM default.** |
| Gemma-3-12B-it | ~7.3 GB | No | Only at 8 GB+, and slow |
| MedGemma-4B / 27B | 2.6 / 16 GB | 4B yes | See note |

**Context budget matters more now.** Two passes over a 3-minute transcript (~450 words ≈ 600 tokens) plus a 50-term glossary (~900 tokens) plus section schema and few-shots lands around 2.5–4k tokens per call. Qwen3-8B at 6k context on 6 GB is workable but tight; if you hit OOM, drop to the 4B before dropping context, because truncating the glossary defeats the repair pass.

**On MedGemma:** still the wrong tool. It's tuned for medical *reasoning and image comprehension*; both your passes are lexical and structural. It also ships under the Health AI Developer Foundation licence with an explicit restriction that outputs "are not intended to directly inform clinical diagnosis, patient management decisions, treatment recommendations, or any other direct clinical practice applications" — a term you'd have to reason about for a tool touching a real chart. A general model doing constrained extraction, with the doctor reviewing every field, sits in a much cleaner position.

**You do not need a frontier model.** Pass A is phonetic-plus-semantic matching against a glossary you hand it. Pass B is grammar-constrained slot-filling. Both are 4B-capable. Hotwords and glossary quality will move your numbers far more than model size will.

### 3.4 PDF — scan as background, real AcroForm fields on top

**v1 posed a false dichotomy** between rebuilding the form as vectors and stamping text at coordinates. The hybrid beats both:

- Embed the existing scan as a full-page background image (deskewed, thresholded to clean 1-bit, upsampled to 300 dpi).
- Position **real named `PDFTextField` / `PDFCheckBox` / `PDFRadioGroup` widgets** on top of it with `pdf-lib`.

You get a form pixel-identical to the one he already knows, genuinely fillable and editable in Acrobat, and you skip reconstructing ~150 labels and rules by hand. Roughly a third of the effort of a full vector rebuild.

The cost is that field rectangles must be measured against the scan. Do it once with a calibration harness: render the background, overlay a labelled grid, print it, mark it up, and transcribe coordinates into a manifest. Half a day, and it's mechanical rather than fiddly.

```
assets/form/
  background-300dpi.png
  field-manifest.json      # name, type, page, rect, options — generated from schema + calibration
src/pdf/
  template.ts              # background + fields → form-template.pdf
  fill.ts                  # EncounterDraft → filled PDF
  calibrate.ts             # grid overlay tool
```

Field names mirror schema paths exactly, so filling is one flat map lookup:

```
od.anterior.lidsLashes          os.posterior.cdRatio.horizontal
plan.glasses[0].od.sphere       plan.testing.tonometry
```

Map the form's affordances honestly: `Angles 1 2 3 4` and `ALR 1 2 3 4` → radio groups; `WNL/PATH`, `VP + −`, `Macular/FLR + −`, `Enzyme Y/N` → radio groups; `Hi-Index/Asph`, `UV 400`, `Polycarb` → checkboxes; `Topography 1 2 3w 1mo 2mo` → radio group; `Fields C-76 / 24-2` and `SITA Std / Fast` → two radio groups; ruled lines → text fields.

**Do not flatten by default** — leave the form live so corrections are possible in Acrobat. Offer flatten-on-sign as an explicit action.

Every PDF carries a footer: `AI-assisted draft — reviewed and signed by ____`, plus timestamp, app version, ASR and LLM model versions, transcript hash, and **the count of Pass A corrections applied**. That last one is a useful smell test for the doctor.

---

## 4. The transcript model

**This is the fix for v1's worst design hole.** v1 regex-normalized the transcript in place, which destroyed the character-offset mapping that the review UI needs to scrub audio to a field's evidence. With an LLM now rewriting the transcript too, a naive string rewrite would be far worse — unauditable as well as unmappable.

**The transcript is never a rewritten string. It is raw text plus an ordered list of anchored edits.**

```ts
interface Edit {
  id: string;
  source: 'repair' | 'lexicon' | 'laterality' | 'human';
  rawStart: number;        // offset into raw transcript
  rawEnd: number;
  original: string;        // MUST match raw.slice(rawStart, rawEnd) verbatim
  replacement: string;
  reason: string;          // glossary term id, rule name, or free text
  accepted: boolean;       // the doctor can reject any single edit
}

interface Transcript {
  raw: string;
  segments: { start: number; end: number; text: string; score: number }[];  // audio timestamps
  edits: Edit[];
  // derived, memoized:
  working: string;                                  // raw + accepted edits applied
  mapToRaw: (workingOffset: number) => number;      // maintained by the edit applier
}
```

The edit applier is ~60 lines of deterministic TypeScript: sort edits by `rawStart`, reject overlaps, materialize `working`, build the offset map. Unit-test it hard — everything downstream depends on it.

What this buys you:

- **Audio scrubbing survives every transform.** An evidence span in `working` maps to `raw` maps to a segment timestamp maps to a position in the audio file.
- **Every LLM change is auditable and individually reversible.** The doctor can see "the model changed *'sudo fake ia'* → *'pseudophakia'*" and reject it.
- **The learning loop is free.** Accepted and rejected edits are exactly the training signal for `spoken` aliases in the lexicon (§5.9).
- **Guards become checkable.** Every safety rule in §5.4 is a predicate over `(original, replacement)` pairs, which is far easier to enforce than reasoning about a free-form rewrite.

---

## 5. Pipeline

```
┌────────────────────────────────────────────────────────────┐
│ 1. PREPROCESS                                       ffmpeg │
│    16 kHz mono PCM · HPF 80 Hz · EBU R128 · Silero VAD trim│
└──────┬─────────────────────────────────────────────────────┘
       ▼
┌────────────────────────────────────────────────────────────┐
│ 2. TRANSCRIBE                          sherpa-onnx · CPU   │
│    Parakeet-TDT-0.6B-v2 int8 · beam search · hotwords      │
│    → Transcript { raw, segments[], edits: [] }             │
│    → ASR QUALITY GATE — abort and ask for a re-record      │
└──────┬─────────────────────────────────────────────────────┘
       ▼
┌────────────────────────────────────────────────────────────┐
│ 3. RETRIEVE GLOSSARY                   Double Metaphone    │
│    phonetic + trigram match over raw → top ~50 terms       │
└──────┬─────────────────────────────────────────────────────┘
       ▼
┌════════════════════════════════════════════════════════════┐
║ 4. PASS A — TRANSCRIPT REPAIR                 LLM · GPU    ║
║    emits anchored (original → replacement) pairs only      ║
║    5 hard guards, incl. negation preservation              ║
║    → Edit[] (source: 'repair')                             ║
└──────┬─────────────────────────────────────────────────────┘
       ▼
┌────────────────────────────────────────────────────────────┐
│ 5. DETERMINISTIC NORMALIZE            TS · also as edits   │
│    number words → digits · "o d" → OD · "twenty twenty"    │
│    → Edit[] (source: 'lexicon')                            │
└──────┬─────────────────────────────────────────────────────┘
       ▼
┌════════════════════════════════════════════════════════════┐
║ 6. LATERALITY EXPANSION                       LLM · GPU    ║
║    "cornea clear OU" → explicit OD + OS statements         ║
║    "OS same except…" → resolved against OD                 ║
║    → Edit[] (source: 'laterality')                         ║
└──────┬─────────────────────────────────────────────────────┘
       ▼
┌════════════════════════════════════════════════════════════┐
║ 7. PASS B — SECTIONED EXTRACTION      LLM · GPU · 6 calls  ║
║    GBNF grammar per section · shared cached prefix         ║
║    → EncounterDraft, every field Extracted<T>              ║
└──────┬─────────────────────────────────────────────────────┘
       ▼
┌────────────────────────────────────────────────────────────┐
│ 8. VALIDATE + SCORE                    zod · ajv · signals │
│    shape · clinical ranges · cross-field · FieldSignal[]   │
└──────┬─────────────────────────────────────────────────────┘
       ▼
┌════════════════════════════════════════════════════════════┐
║ 9. HUMAN REVIEW                         ← NON-OPTIONAL     ║
║    transcript ‖ fields · repair diff visible               ║
║    flagged fields amber · click field → scrub audio        ║
║    doctor edits, accepts/rejects repairs, signs            ║
║    → corrections logged to the learning loop               ║
└──────┬─────────────────────────────────────────────────────┘
       ▼
┌────────────────────────────────────────────────────────────┐
│ 10. RENDER                                        pdf-lib  │
│     fill AcroForm by dotted name · provenance footer       │
└────────────────────────────────────────────────────────────┘
```

### 5.1 Preprocess — be conservative

Resample to 16 kHz mono, high-pass at ~80 Hz, loudness-normalize (EBU R128), VAD-trim silence. That's it.

**Aggressive denoising reliably makes ASR worse** — it introduces artefacts unlike anything in the model's training distribution. Spectral gating in particular will cost you accuracy. VAD trimming alone is a large speed win, since real dictations run ~40% silence.

If the clinic is genuinely noisy, sherpa-onnx ships a GTCRN speech-enhancement model. **A/B it on your own samples before enabling.** Ship it off by default.

### 5.2 ASR quality gate

v1 had none, which meant a garbage transcript would flow straight through to structured nonsense on a doctor's desk. Gate on:

- **Words per second of speech** far below expectation (< 1.5 wps) → likely the model lost the signal.
- **Mean per-token score** below threshold (calibrate on your samples).
- **Glossary hit rate** — an ophthalmic dictation that phonetically matches almost no glossary terms is suspicious.

On failure, stop and ask for a re-record. Do not proceed and hope repair rescues it.

### 5.3 Glossary retrieval — phonetic, because ASR errors are phonetic

This is the key idea that makes glossary injection affordable.

An 800-term glossary with one-line descriptions is ~12k tokens. Dumping that into a 4B's context leaves no room for the transcript and degrades attention across the board. But ASR errors are *phonetic* errors by construction — "sudo fake ia" is what "pseudophakia" sounds like. So retrieve phonetically:

```ts
import { doubleMetaphone } from 'double-metaphone';   // v2.0.1, zero deps, ships .d.ts

// build time: index every term + alias + observed spoken form
for (const t of lexicon.terms) {
  for (const s of [t.term, ...t.aliases, ...t.spoken]) {
    const [primary, secondary] = doubleMetaphone(s.replace(/\s+/g, ''));
    index.add(primary, t.id);
    if (secondary !== primary) index.add(secondary, t.id);
  }
}

// query time: slide 1–4 word n-grams over the raw transcript
for (const ngram of ngrams(raw, 1, 4)) {
  const [p, s] = doubleMetaphone(ngram.replace(/\s+/g, ''));
  for (const id of index.get(p) ?? []) score(id, 3.0);
  for (const id of index.get(s) ?? []) score(id, 2.0);
  for (const id of trigramCandidates(ngram)) score(id, 1.0);   // catches non-phonetic errors
}

const glossary = topK(scores, 50);   // ~900 tokens, comfortably affordable
```

Add a small section prior from the lexicon's `sections` field, and always include a floor set of ~15 ubiquitous terms (OD, OS, OU, C/D, IOP, WNL) regardless of match.

Tune K empirically. Too few and you miss repairs; too many and you invite the model to "correct" toward terms that aren't there. Start at 50.

### 5.4 Pass A — transcript repair, with teeth

**The job:** given the raw transcript and ~50 candidate glossary terms with one-line glosses, emit a list of anchored corrections. Nothing else.

**The prompt shape** (transcript first — see §5.6):

```
<raw transcript>

---
Candidate ophthalmology terms that may appear above, with definitions:
- pseudophakia — Eye with an implanted intraocular lens after cataract surgery.
- Shafer's sign — Pigment cells in the anterior vitreous; suggests retinal break.
  [...48 more]
---

The transcript above came from automatic speech recognition of an
ophthalmologist dictating clinical findings. Speech recognition errors are
common on medical vocabulary and on Indian-accented English.

Emit a list of corrections. For each:
  "original"    — text copied EXACTLY from the transcript, character for character
  "replacement" — the corrected text
  "term_id"     — the glossary term this correction is based on, or null

Rules:
  • Correct ONLY speech-recognition errors. Never add, remove or alter clinical content.
  • NEVER change, add or remove a negation ("no", "without", "denies", "absent").
  • If you are unsure whether something is an error, leave it alone.
  • If the transcript is already correct, emit an empty list.
  • Do not correct toward a glossary term unless the transcript text plausibly
    sounds like that term.
```

**Five hard guards, enforced in TypeScript, not trusted to the prompt.** Every correction must pass all five or it is dropped and logged:

| # | Guard | Rejects |
|---|---|---|
| 1 | `original` appears verbatim in the working transcript | Hallucinated anchors; guarantees the edit is applicable |
| 2 | `replacement` is a glossary term, alias, or a glossary term plus a numeral/unit pattern | Free-form invention |
| 3 | **Phonetic distance** — `doubleMetaphone(original)` within threshold of `doubleMetaphone(replacement)` | *"no cataract"* → *"nuclear cataract"*. This is the guard that stops plausible-sounding clinical fabrication. |
| 4 | **Negation preservation** — the set of negation tokens in `original` equals that in `replacement` | Negation flips: the single most dangerous error class in clinical NLP |
| 5 | Total accepted corrections ≤ 25 per transcript | Runaway rewriting; more than 25 means ASR failed → escalate to the quality gate |

Guards 3 and 4 are not optional. A repair pass without them is a clinical-fabrication engine with a friendly interface.

**Short-circuit:** if glossary retrieval scores nothing above threshold, skip Pass A entirely. Many transcripts will need no repair, and you save 3–8 s.

**Why two passes rather than one.** Your instinct is right, and the reasons compound:

- Each pass has one job, which is exactly what small models want.
- **Pass A output is human-readable prose with a visible diff.** A doctor can glance at "12 corrections applied" and spot-check them. A single-pass model that silently misreads a term buries that error inside a field value where nobody will ever see it.
- Pass A's failure modes are guardable with string predicates (above). Pass B's are guardable with a grammar. Merged, neither guard applies cleanly.
- You can measure and tune them independently.

The cost is one extra generation of roughly transcript length. Worth it.

### 5.5 Laterality expansion

Real dictation is full of shorthand that no per-eye extraction call can resolve on its own:

```
"cornea clear OU"                    → both eyes, one statement
"anterior segment quiet bilaterally" → blanket, both eyes
"OS same except cup is point seven"  → reference to OD content
"and the left the same"              → ditto
```

v1 had nothing for this, and the per-eye sectioning in Pass B arguably made it *worse*: the OS call has to resolve a reference to OD content it isn't being asked to produce.

So resolve it explicitly, before extraction, as its own constrained call. Output is again anchored edits — expansions rather than substitutions:

```
"cornea clear OU"  →  "cornea clear OD. cornea clear OS."
```

Guards: an expansion may only duplicate or restate existing spans, never introduce a finding absent from the transcript; and an expansion must name exactly one eye per resulting clause. Keeping this separate from Pass A matters because the safety profiles differ — repair *substitutes* content, expansion *duplicates* it.

This keeps Pass B's six calls independent and order-free, which is worth a lot operationally.

### 5.6 Pass B — sectioned extraction

Six calls against the same working transcript:

```
1. od.anterior      (8 fields)     4. os.posterior  (11 fields)
2. os.anterior      (8 fields)     5. assessment    (free text list)
3. od.posterior     (11 fields)    6. plan          (Rx, testing, recommendations)
```

A single 120-field grammar on a 4–8B model degrades badly — dropped fields, cross-contamination, grammar-valid nonsense. Small grammars give higher per-field accuracy, cheap targeted retries, and make OD/OS confusion structurally harder because each call is told which eye it is looking at.

**Prompt ordering is load-bearing.** `cache_prompt` is prefix-based — *"the common prefix does not have to be re-processed, only the suffix that differs."* So:

```
[ working transcript ]        ← identical across all 6 calls, cached after call 1
[ section instruction ]       ← varies
[ section schema + few-shots] ← varies
```

v1 had this backwards and claimed a cache benefit it would not have received. Inverted, the six calls process the transcript once. Set `cache_prompt: true` and accept the documented nondeterminism caveat.

**Prompt rules, non-negotiable:**

- "Emit `null` for anything not explicitly stated. Never infer. Never carry a finding from one eye to the other."
- "`evidence` must be a verbatim substring of the transcript."
- State the schema in the prompt even though the grammar enforces it — grammar constrains shape, the prompt supplies intent.
- **"A blanket 'WNL' does not populate individual fields."** See §6.3.

Request `n_probs` so §6.2 has logprobs to work with.

---

## 6. The schema

The hard part of the project, and a **domain** problem rather than an engineering one. Budget real time with your friend.

### 6.1 Shape

```ts
// src/schema/form-schema.ts — single source of truth

interface Extracted<T> {
  value: T | null;
  evidence: string | null;   // verbatim span in the working transcript
}
// NOTE: no self-reported confidence. See 6.2.

interface AnteriorSegment {
  status: Extracted<'WNL' | 'PATH'>;
  lidsLashes:      Extracted<string>;
  conjunctiva:     Extracted<string>;
  sclera:          Extracted<string>;
  angles:          Extracted<1 | 2 | 3 | 4>;
  cornea:          Extracted<string>;
  irisPupil:       Extracted<string>;
  anteriorChamber: Extracted<string>;
  lensMedia:       Extracted<string>;
}

interface PosteriorSegment {
  status:     Extracted<'WNL' | 'PATH'>;
  lens:       Extracted<'20D' | '78D' | 'Direct'>;
  media:      Extracted<string>;
  cdRatio:    { horizontal: Extracted<number>; vertical: Extracted<number> };
  shapeType:  Extracted<string>;
  rimTissue:  Extracted<string>;
  venousPulsation: Extracted<boolean>;      // VP + / −
  posteriorPole:   Extracted<string>;
  avRatio:    Extracted<string>;
  alr:        Extracted<1 | 2 | 3 | 4>;     // arteriolar light reflex
  macularFLR: Extracted<boolean>;           // foveal light reflex + / −
  periphery:  Extracted<string>;
}

interface SpectacleRx {
  usage: Extracted<'DV' | 'NV' | 'INT' | 'Other'>;
  usageOther: Extracted<string>;
  od: { sphere: Extracted<number>; cylinder: Extracted<number>; axis: Extracted<number> };
  os: { sphere: Extracted<number>; cylinder: Extracted<number>; axis: Extracted<number> };
  prism: Extracted<string>;
  add:   Extracted<number>;
}

interface EncounterDraft {
  meta: {
    transcriptHash: string; generatedAt: string;
    asrModel: string; llmModel: string;
    repairEditCount: number; lateralityEditCount: number;
  };
  od: { anterior: AnteriorSegment; posterior: PosteriorSegment };
  os: { anterior: AnteriorSegment; posterior: PosteriorSegment };
  assessment: Extracted<string>[];
  plan: {
    glasses: [SpectacleRx, SpectacleRx];
    contacts: ContactLensRx;
    testing: AdditionalTesting;
    recommendations: Recommendations;
    additionalInstructions: Extracted<string>;
  };
}
```

### 6.2 Confidence is computed, never self-reported

v1 had the model emit `confidence: 0.85` per field and built the review UI on it. **Small models are badly calibrated on introspective confidence** — that number correlates weakly with correctness, and it costs output tokens to produce. Removed.

Replaced with signals that are *verifiable*:

```ts
interface FieldSignal {
  path: string;
  hasEvidence: boolean;        // model returned a span
  evidenceVerbatim: boolean;   // string-matched against the working transcript
  evidenceResolved: boolean;   // mapped back through edits to raw + audio timestamp
  decisionLogprob: number;     // logprob at the null-vs-value decision token
  touchedByRepair: boolean;    // evidence span overlaps a Pass A edit
  validation: 'ok' | 'warn' | 'fail';
}
```

Flag a field for review when: `!evidenceVerbatim` (the model fabricated a citation — always flag), `validation !== 'ok'`, `decisionLogprob` below threshold, or `touchedByRepair` (the text this came from was itself corrected, so it deserves a second look).

**One subtlety on logprobs.** Under a grammar, probabilities are renormalized over *allowed* tokens, so a field the grammar forced looks spuriously confident. Measure the logprob at the **decision point** — the token where the model chose `null` versus a value — not the mean across the whole span. Getting this wrong makes the signal worse than useless.

### 6.3 "Not examined" vs "normal" vs "not mentioned" — **DECIDED: leave blank**

If the doctor toggles "anterior segment WNL" and says nothing about sclera, `sclera` stays `null`.

**The LLM never populates an individual field from a blanket WNL.** The PDF renders the WNL toggle and leaves the line blank — exactly what the paper form does today. The system does not invent findings, and "normal" is a finding.

Consequences to implement:

- Pass B prompt rule (§5.6) stands as written: a blanket WNL does not propagate.
- The validator's cross-check still applies in the other direction — a segment marked WNL alongside a pathological free-text finding is a contradiction, and gets flagged.
- **Review UI nicety, costs nothing:** shade blank fields that sit under an *active* WNL toggle differently from blank fields that don't. Both stay empty, but the doctor can tell "blank and expected" from "blank — did I forget to dictate this?" at a glance.

This is a behavioural default, not a schema constraint. If he later decides the blanket should propagate, that's a schema change — you'd add a third state (`covered-by-blanket`) so a propagated normal stays visually distinguishable from a dictated one. Don't build that now, but don't design anything that forecloses it.

### 6.4 Generated artefacts

```
form-schema.ts
   ├─→ zod schemas           runtime validation
   ├─→ JSON Schema           per section
   │      └─→ GBNF grammar   llama.cpp constrained decoding
   ├─→ PDF field manifest    name, type, page, rect, options
   └─→ review UI field list  label, group, order, widget
```

Write the codegen on day one, and add a CI check that regenerates and diffs. The moment two of these are hand-maintained they drift, and a drifted field silently drops a clinical finding.

### 6.5 Clinical validation rules

Grammar guarantees shape; these guarantee sense. Violations are **flagged, never silently corrected**.

| Field | Rule |
|---|---|
| C/D ratio | 0.0 – 1.0, quantized to 0.05 |
| Angles / ALR | integer 1–4 |
| Axis | integer 0–180 |
| Sphere | −30.00 to +20.00, 0.25 steps |
| Cylinder | 0.25 steps; **flag if positive — never auto-transpose** |
| Add | +0.75 to +4.00, 0.25 steps |
| IOP (if captured) | 0–80 mmHg |
| BC (contacts) | 7.0 – 10.0 mm |
| Diameter | 12.0 – 16.0 mm |

**Minus-cyl is a flag, not a fix.** Transposing cylinder is a clinical transformation. If the doctor dictated plus-cyl, surface it and let him decide.

**Cross-field checks:**

- OD and OS identical verbatim across many fields → likely contamination → flag loudly.
- Posterior segment marked WNL with a pathological free-text finding → flag.
- `add` present on a DV-only Rx → flag.
- A field whose evidence span overlaps a *rejected* repair edit → flag.

---

## 7. Electron architecture (after the PoC)

```
┌─────────────────────────────────────────────────────┐
│ MAIN PROCESS                                        │
│  orchestration · encounter store · encryption       │
│  child lifecycle (llama-server, ffmpeg) · audit log │
│  the ONLY place plaintext PHI exists in memory      │
└───┬──────────────────┬───────────────────┬──────────┘
    │ typed IPC        │ utilityProcess    │ HTTP 127.0.0.1
    ▼                  ▼                   ▼
┌─────────────┐  ┌──────────────┐  ┌──────────────────┐
│ RENDERER    │  │ ASR WORKER   │  │ llama-server.exe │
│ UI only     │  │ sherpa-onnx  │  │ --api-key <rnd>  │
│ no node     │  │ native addon │  │ --port  <rnd>    │
│ no network  │  │ CPU          │  │ GPU              │
└─────────────┘  └──────────────┘  └──────────────────┘
```

**Hard rules:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, narrow typed preload bridge. CSP `default-src 'self'; connect-src 'none'` — the renderer never touches the network. Native addons in a `utilityProcess`, never the renderer, so a segfault doesn't take the UI down. `llama-server` binds `127.0.0.1` only. Electron fuses: `RunAsNode` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on.

*(On the llama-server API key: against a local attacker it's theatre. Its real value is stopping other local applications from casually using your model endpoint. Worth having, not worth relying on.)*

### Storage & security

- Audio, transcripts and edit lists encrypted at rest; key via Electron `safeStorage` (DPAPI on Windows).
- Configurable audio retention with automatic purge (default 30 days). Transcripts and drafts follow the practice's record-retention policy.
- **Structured logging with a redaction allowlist.** Log field *names*, validation outcomes, timings, model versions, edit counts. Never values, transcript text, or identifiers. Make the logger structurally incapable — have it accept `FieldSignal`, which contains no PHI by construction.
- Append-only, hash-chained audit log: who, when, which encounter, which fields the model proposed, which repairs were applied or rejected, what the human changed. Retain ≥ 1 year.
- Crash reporting **off**, or self-hosted. A stack trace containing a transcript is a breach.

### Packaging

- `electron-builder`, NSIS, x64.
- **Models ship separately** — ~630 MB ASR + 2.5–5 GB LLM does not belong in an installer. First-run downloader with SHA-256 verification, plus an offline USB bundle as a supported path. Indian clinic bandwidth is not a given.
- Native addon needs `asarUnpack` for the `.node` file *and* its sibling DLLs. Most common Electron packaging failure — test the packaged build on a clean VM from week one, not the week before delivery.
- `llama-server.exe` + backend DLLs in `extraResources`. Ship **both** CUDA and **Vulkan** builds; detect at first run. Vulkan is the pragmatic default — one binary across NVIDIA, AMD and Intel, at a modest speed cost.

---

## 8. Indian data protection — orientation

> Not legal advice, and I'm not a lawyer. The regime changed recently and operative provisions are still phasing in. Have an Indian privacy lawyer review before this touches a real patient. This is enough to make the architectural decisions correctly.

### Where the law stands

The **Digital Personal Data Protection Act, 2023** plus the **DPDP Rules, 2025** (notified **13 November 2025**). Phased rollout:

| Date | What commences |
|---|---|
| 13 Nov 2025 | Data Protection Board of India established |
| 13 Nov 2026 | Consent Manager registration provisions |
| **13 May 2027** | **Core operational obligations** |

Until then the **IT Act, 2000 and SPDI Rules, 2011** govern — and those explicitly classify *medical records and history* and *physical, physiological and mental health condition* as **Sensitive Personal Data or Information**. So health data is a special category **today**, even though the DPDP Act notably collapses that distinction and treats all digital personal data alike. Satisfy SPDI now; design for DPDP.

### Who is who

The **practice** is the Data Fiduciary. **You** are a Data Processor *only if* data ever reaches your infrastructure — a purely local desktop app that never phones home arguably keeps you out of the chain entirely. That is a real and substantial simplification, and a good reason to stay local. A written processing agreement is required between them regardless.

### What the practice will owe by May 2027

Itemised notice and consent in plain language, available in the Eighth Schedule languages; purpose limitation and minimisation; reasonable security safeguards; breach notification to individuals and the Board **without delay**, with detailed particulars to the Board **within 72 hours**; retention limits and erasure on withdrawal. Penalties up to **₹250 crore** per contravention for security-safeguard failures.

### Cross-border transfer and the OpenRouter question

**The legal answer is narrower than expected.** DPDP §16 uses a **negative list**, not GDPR-style adequacy: transfer abroad is permitted *unless* the Central Government restricts the destination. No blacklist has been notified. Routing to a foreign LLM API is **not per se prohibited**.

**The architectural answer is still: don't.**

1. **OpenRouter is a router, not a provider.** Data goes to OpenRouter *and then* to whichever upstream serves the request, with per-provider retention, logging and training policies that vary and change. That's an indeterminate sub-processor set in a clinical data flow — hard to paper in a DPA, harder to explain in a consent notice.
2. **It converts a simple product into a regulated data flow** — transfer story, sub-processor list, vendor breach exposure, and it likely puts you in the Data Processor role.
3. **Significant Data Fiduciary risk.** If the practice is ever designated an SDF, localisation attaches to specified categories, plus an India-resident DPO, annual audits and DPIAs. A cloud dependency now is a migration later.
4. **You don't need it.** Both passes are lexical and structural. There's no meaningful quality gap to trade for.

**If a local model genuinely cannot do it**, escalate in order and stop at the first rung that works:

| Rung | Option | Notes |
|---|---|---|
| 1 | Bigger local model on a dedicated mini-PC | ₹60–80k buys 16 GB VRAM. Permanent fix, no legal surface. |
| 2 | **De-identify, then call out** | Identifiers never enter the transcript the model sees — they come from a separate form field and merge locally *after* extraction. **Do this regardless of hosting.** |
| 3 | Indian-region managed cloud | Azure OpenAI or Bedrock in Mumbai, or an Indian provider. Named sub-processor, contractual no-training, resident in India. |
| 4 | OpenRouter | Only with rung 2, a zero-retention provider explicitly pinned, and legal sign-off. |

Rung 2 bears repeating: **architect so the LLM never sees an identifier, whatever you decide about hosting.** Cheap, good practice, and it makes the hosting question far less load-bearing.

### Also in scope

**NMC / MCI Code of Ethics Regulations** (retain records 3 years for indoor patients; provide on request within 72 hours). **Telemedicine Practice Guidelines, 2020** if any consultation is remote. **EHR Standards for India, 2016** — recommends SNOMED CT, LOINC, FHIR; not mandatory for a standalone practice tool, but if ABDM interoperability is ever wanted, the schema should be mappable to FHIR resources. Worth a look before finalising field names. **ABDM Health Data Management Policy** only if the practice joins that ecosystem.

### Product decisions this drives

Default fully local; cloud is explicit, off by default, per-install, with a visible indicator when active. Ship a consent-notice template. De-identify before the LLM, always. Every PDF stamped as an AI-assisted draft requiring physician review and signature — which is also what keeps this a documentation aid rather than clinical decision support, a meaningfully different regulatory category.

---

## 9. PoC build plan

**Scope:** headless TypeScript CLI. Pre-recorded audio in, filled PDF out.

```bash
ophtha-scribe transcribe samples/case-01.wav          -o out/case-01.transcript.json
ophtha-scribe repair     out/case-01.transcript.json  -o out/case-01.repaired.json
ophtha-scribe extract    out/case-01.repaired.json    -o out/case-01.draft.json
ophtha-scribe render     out/case-01.draft.json       -o out/case-01.pdf
ophtha-scribe run        samples/case-01.wav          -o out/case-01.pdf
ophtha-scribe eval       samples/                     --report eval/report.html
```

Every stage reads and writes JSON. Iterate on repair prompts without re-running ASR; every intermediate is inspectable. `repair` prints a coloured diff by default — you will live in that command.

### Steps

**Step 0 — Scaffold** *(0.5 d)*
pnpm, TypeScript strict, vitest, commander.
```
src/{asr,lexicon,llm,pdf,schema,pipeline,eval,cli}/
assets/{models,form}/
lexicon/ophthalmology.json
samples/   eval/gold/        # both gitignored — PHI
```

**Step 1 — Real audio + the term list** *(blocking, do first)*
5–10 dictations from your friend, real or realistic completed charts, varying length, at least one noisy. **Everything downstream is guesswork without these.** In the same sitting, get the first 200 glossary terms and — critically — *how he says them out loud*.

**Step 2 — Schema + lexicon** *(2–3 d, with the doctor)*
All ~120 fields: type, allowed values, units, spoken forms. Write the codegen (schema → zod, JSON Schema, GBNF, PDF manifest; lexicon → hotwords, phonetic index).

**Step 3 — Eval harness** *(1.5 d)* ← **moved up from v1's step 9**
Hand-label gold JSON for each sample *and* gold repaired transcripts. You cannot tune Steps 5–7 without this. Building it before the work it measures is the single highest-leverage change in v2.

**Step 4 — ASR + hotwords + quality gate** *(1.5 d)*
Wire sherpa-onnx. Generate hotwords from the lexicon. Measure WER overall **and on the clinical-term subset specifically** — overall WER hides exactly the failures that matter. Implement the §5.2 gate.

Decision point: if clinical-term WER stays above ~40% even with hotwords, switch to whisper-large-v3-turbo now. Repair can fix phonetically-close errors; it cannot recover lost signal.

**Step 5 — Glossary retrieval** *(1 d)*
Double Metaphone index, n-gram query, trigram fallback, section priors. Measure **retrieval recall**: of the clinical terms actually spoken, how many appear in the top-K? Tune K. Target > 95%.

**Step 6 — Pass A + guards** *(2–3 d, iterative)*
Repair prompt, anchored-edit grammar, all five guards, the edit applier and offset map. Unit-test the applier hard.

**Step 7 — Laterality expansion** *(1 d)*

**Step 8 — Pass B extraction** *(2–3 d, iterative)*
Six sectioned calls, transcript-first prompt ordering, `cache_prompt: true`, `n_probs` on.

**Step 9 — Validation + signals** *(1 d)*

**Step 10 — PDF** *(1.5 d)*
Background calibration, field manifest, template generator, filler. Verify in Acrobat, Chrome and Edge — field rendering differs across all three.

**Step 11 — Learning loop** *(0.5 d)*
Log accepted/rejected edits and human field corrections to a local JSONL. A `lexicon:suggest` command proposes new `spoken` aliases from it. Small, and it compounds.

**Effort: ~16–19 working days. Calendar: 4–6 weeks.** Steps 1 and 2 depend on a busy clinician; Steps 6 and 8 are unbounded prompt iteration. v1's "11–14 days" conflated the two.

### Acceptance criteria

| Metric | Target |
|---|---|
| Clinical-term WER after hotwords | < 30% raw |
| Glossary retrieval recall @ K=50 | > 95% |
| **Repair precision** (applied corrections that were right) | > 90% |
| **Repair recall** (mangled clinical terms fixed) | > 70% |
| **Harmful corrections** (changed clinical meaning) | **0** |
| **Negation flips** | **0** |
| Field-level F1 vs gold | > 0.85 |
| Hallucinated fields | < 1% |
| **Laterality (OD/OS) errors** | **0** |
| Evidence-span verbatim validity | 100% |
| End-to-end, 3-min dictation, 6 GB GPU | < 45 s |
| PDF editable in Acrobat + Chrome + Edge | yes |

The three zero targets are clinical-safety gates, not aspirations. If any is non-zero at the end of the PoC, the honest conclusion is that the design needs another round before it goes near a patient.

---

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Pass A fabricates clinical content** | **Critical** | Five guards (§5.4), especially phonetic distance and negation preservation; harmful-correction rate is a zero-target eval metric; every edit visible and reversible in review |
| **Negation flips** ("no cataract" → "nuclear cataract") | **Critical** | Guard 4; dedicated eval cases; separate metric |
| OD/OS contamination | **Critical** | Laterality expansion stage; per-eye sectioned calls; cross-field identity check; zero-target metric |
| Hallucinated findings in Pass B | **Critical** | Grammar + nullable everything + verbatim evidence spans + human review + <1% gate |
| Parakeet too weak on the accent | High | Step 4 decision point; whisper-large-v3-turbo fallback via same runtime |
| Glossary retrieval misses terms | High | Recall metric with 95% target; floor set of ubiquitous terms; `spoken` aliases grow via learning loop |
| Blanket-WNL semantics misread | High (clinical) | **Resolved** — §6.3: blanket never propagates, field stays blank. Eval cases must cover a blanket-WNL dictation and assert the individual fields are null. |
| Two passes too slow to feel usable | Medium | Short-circuit Pass A on no glossary hits; measure early; 4B fallback |
| 6 GB VRAM too tight at required context | Medium | Qwen3-4B fallback; never truncate the glossary to save context |
| Electron native-addon packaging | Medium | `asarUnpack`; clean-VM test from week one |
| Schema/lexicon drift across generated artefacts | Medium | Codegen day one; CI regenerate-and-diff |
| Model download in low-bandwidth clinic | Medium | Offline USB bundle as a supported install path |
| Scope creep into clinical decision support | High (regulatory) | Hold the line. It transcribes what was said. It never suggests. |

---

## 11. Open questions

1. **Is this page 2 of the chart?** No demographics, VA or refraction section. If a page 1 exists it should be in scope now — and the identifiers on it are exactly what must never reach the LLM.
2. **Where do identifiers come from?** Typed in, or pulled from practice-management software? Determines whether de-identification is trivial or needs an integration.
3. **One dictation per patient, or per section?** Affects UX and chunking.
4. **Does he dictate in English throughout,** or code-switch? Code-switching would push toward Parakeet v3 or Whisper and changes the whole ASR calculus.
5. **Original digital form file?** If the designer still has the Word/InDesign/Illustrator source, it beats the background-scan approach and saves the calibration step.
6. **Existing EMR?** Does this write into one, or is the PDF the final artefact?
7. **Audio retention.** Deleting after review is the cleanest privacy posture but destroys your ability to debug and improve. Needs an explicit decision.
8. **How many concurrent users?** One workstation changes nothing; several exam rooms sharing a GPU box changes the deployment model.

**Resolved:** blanket-WNL semantics → §6.3, fields stay blank.

---

## Appendix A — Sources

- sherpa-onnx NeMo transducer models — https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html
- sherpa-onnx repository — https://github.com/k2-fsa/sherpa-onnx
- `sherpa-onnx-node` on npm — https://registry.npmjs.org/sherpa-onnx-node/latest
- llama.cpp server README (`cache_prompt`, `n_probs`, grammar, json_schema) — https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- node-llama-cpp grammar guide — https://node-llama-cpp.withcat.ai/guide/grammar
- `double-metaphone` on npm (v2.0.1) — https://registry.npmjs.org/double-metaphone/latest
- MedGemma model card and licence — https://huggingface.co/google/medgemma-27b-text-it
- DLA Piper Data Protection Laws of the World, India — https://www.dlapiperdataprotection.com/index.html?t=law&c=IN
- DPDP Act 2023 overview — https://en.wikipedia.org/wiki/Digital_Personal_Data_Protection_Act,_2023
