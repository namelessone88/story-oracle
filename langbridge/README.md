# LangBridge · 中英名称桥

A **standalone** SillyTavern extension: type English and read English names,
while everything stored and scanned stays canonical Chinese.

No dependency on Story Oracle or any other extension. (It currently lives in
this repository for convenience — the folder is self-contained and can be moved
to its own repo unchanged.)

---

## What problem it solves

The model writes 沈慕微, not "Shen Muwei" — so World Info keys fire, CG trigger
entries inject, the draw module's Chinese substring detection works, and MVU
variables stop fragmenting across spellings. LangBridge makes that Chinese
storage *readable* in English, and makes English *typing* work:

* **Display layer** — Chinese names are rewritten to English in the rendered
  DOM only. The chat file never contains a single English name.
* **Input layer** — English typing fires World Info because English trigger
  keys are planted in the worldbook once, at setup time. There is no runtime
  input transformation.

### Invariants

| | |
|---|---|
| **I1** | Never modifies `message.mes` or the chat file — DOM only |
| **I2** | Zero per-turn LLM calls (LLM use is confined to the Setup Pass) |
| **I3** | Never alters an author's original keys or per-entry flags — only appends |
| **I4** | No runtime input transformation |
| **I5** | Never breaks the host — every ST touchpoint degrades gracefully |

---

## Install

Copy the `langbridge/` folder to
`SillyTavern/public/scripts/extensions/third-party/langbridge/`, then reload.
The panel appears in **Extensions → LangBridge · 中英名称桥**.

Prerequisites (both outside this extension):

1. Your preset must **not** force English names in output — the model must
   write Chinese. This is the whole premise.
2. Global World Info **"Match whole words" must be OFF** (necessarily already
   true if Chinese keys work at all).

---

## Status — what is built

**Built and tested (this increment):**

* Host Adapter — all SillyTavern coupling isolated in `host.js`
* Name Registry — schema, normalization, per-book persistence, import/export
* Display runtime — name rendering, trigger highlighting, toggles
* Hover cards — canonical + English, aliases in both languages, which entries a
  key triggers and their sibling keys, copy-中文
* Non-LLM **扫描** — reads a worldbook and builds the entry index + a name
  skeleton (seeds `aliases_zh` from existing keys). Read-only: writes nothing.
* 86 passing tests (39 core + 18 sample + 29 DOM)

**Not built yet (next increment):** the **LLM Setup Pass** — entry
classification, romanization, English key emission, the collision screen, the
worldbook write-back, the consistency report, and LittleWhiteBox alias sync.
`host.js` already contains the write-back (`appendKeysToBook`, with re-read +
delta-append + fingerprint guard) and the LLM transport (`setupCompletion`), so
that increment is prompt + orchestration work, not plumbing.

Until then, English trigger keys can be added by hand in ST's World Info editor,
and `display_en` values can be filled in via **编辑登记表**.

---

## Use

1. Pick your worldbook in the panel, press **扫描**. This indexes entries (which
   the hover cards need) and seeds one name per entry. Nothing is written to the
   worldbook.
2. Press **编辑登记表** and fill in `display_en` for the names you want shown in
   English, and set `category` (`character` / `location` / `faction`) and
   `displayPolicy` (`en` / `zh`).
3. Toggle what you want rendered. `sample-registry.json` can be **导入** to see
   the whole thing working before touching your own book.

### Display policy

`displayPolicy: "en"` renders the English form; `"zh"` leaves the Chinese. The
intent (per spec) is that *semantically meaningful* names stay Chinese and
*phonetic transliterations* become English — but this is a judgement call, so it
is per-entity and always overridable.

**Single-hanzi names** (红, 陶, 瓷, 窑, 蛸) are forced to `zh` and excluded from
highlighting: a single hanzi substring-matches ordinary prose (红 hits 红色,
脸红, 红衣) and CJK has no word boundaries. Set
`"allowSingleCharHighlight": true` on that entity to override.

### Hover cards are a static lookup, not activation state

The card says *"triggers these entries"* — never *"this entry is active"*. A
key's presence means the entry is **triggerable** while the message is in scan
depth; probability rolls, cooldowns, token budget and recursion decide actual
injection. A confirmed-fired tier via `WORLD_INFO_ACTIVATED` is future work.

### Highlighting your own messages

Off by default. Turning it on doubles as **drift detection**: type an English
sentence and if nothing lights up, no key covers that phrasing yet — add one.

---

## Tests

```sh
sh langbridge/run-tests.sh
# DOM suite needs jsdom:
LB_JSDOM=/path/to/node_modules sh langbridge/run-tests.sh
```

`matcher.js` and `registry.js` are pure (no DOM, no ST) and carry the rules that
matter: longest-first matching (东海海域 must beat 东海; 归墟潮眼 must beat
归墟), ASCII word boundaries for English tokens without regex lookbehind (older
Safari lacks it), CJK matching without boundaries, and the single-hanzi rule.
The DOM suite covers idempotency, byte-exact strip reversibility, the skip-list,
and toggle round-trips.

---

## Still to verify against a live SillyTavern

These could not be checked without a running instance and are marked `VERIFY` in
the source:

1. **`/scripts/world-info.js` export names** (`loadWorldInfo`, `saveWorldInfo`,
   `getSortedEntries`, book-name list) on your ST version — these are internal
   APIs, not a public contract. Failure is handled (display-only mode), but
   scanning/write-back would be unavailable.
2. **Whether `saveWorldInfo` makes new keys live in the current session** or a
   chat reload is required before the scanner sees them.
3. **Event names** in `eventTypes` for the six hooks — string fallbacks are in
   place, and the MutationObserver covers the rest.
4. **Real container selectors** for MVU / status-bar / LittleWhiteBox regions,
   to extend `DEFAULT_SKIP_SELECTORS` in `runtime.js`. The current list is
   educated guesswork plus generic safety (`code`, `pre`, images).
5. **Mobile** — tap-to-open hover cards and panel usability.
6. **Long-chat performance** with highlighting on (the observer is debounced and
   the pass is idempotent, but this wants a real 300-message chat).
