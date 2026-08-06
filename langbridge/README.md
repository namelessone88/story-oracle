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

**Built and tested:**

* Host Adapter — all SillyTavern coupling isolated in `host.js`
* Name Registry — schema, normalization, per-book persistence, import/export
* Display runtime — name rendering, trigger highlighting, toggles
* Hover cards — canonical + English, aliases in both languages, which entries a
  key triggers and their sibling keys, copy-中文
* Non-LLM **扫描** — reads a worldbook and builds the entry index + a name
  skeleton (seeds `aliases_zh` from existing keys). Read-only: writes nothing.
* **⚙️ 自动设置 (Setup Pass)** — classification, romanization, English key
  emission, collision screen, review-before-write, worldbook write-back with
  the `addedKeys` ledger
* **Consistency report** — near-miss name detection between the worldbook and a
  drawing library, CG/cast cross-checks, dead A1111 weight syntax
* 193 passing tests (39 core + 18 sample + 65 setup + 42 pass + 29 DOM)

**Not built:** LittleWhiteBox *write* sync (§4 Step 5). The report **reads** a
draw library defensively and flags mismatches, but never writes to it — that
extension's storage shape is unverified, and with Chinese names restored in
output the sync is a hardening step, not load-bearing.

### What the Setup Pass does

Batched LLM calls (bounded concurrency 2, abortable, cached by entry-content
hash so re-runs and resumed runs don't re-spend tokens):

1. Classifies each entry as character / location / faction / concept.
2. Romanizes names (surname-first pinyin) and decides whether the Chinese or
   English form should be *displayed* — phonetic names (归墟 → "Guixu") lean
   English, meaningful ones (天剑宗 → "Heavenly Sword Sect") stay Chinese.
3. **Translates the entry's own Chinese trigger words** into English — entry 32's
   传送阵 / 传送费用 / 购买力 / 灵石价格 / 跨域传送 / 路费 each gain an English
   sibling, rather than the entry getting a few invented phrases that may not
   match how you actually ask. Then it **screens every one** against a
   code/UI vocabulary blocklist and against the card's own status-bar templates,
   variable lists and a real sample AI reply. `level` is rejected;
   `cultivation level` survives. This matters because the World Info scanner
   reads the raw message including MVU blocks and status-bar HTML — a key that
   appears in that machinery would fire every single turn.
4. Shows you exactly what would be written, then writes only on approval.

Safety properties, all tested:

* **Only appends.** Original keys, `keysecondary`, `matchWholeWords`,
  `caseSensitive`, content and comments are never touched.
* **Blue-light (constant) and disabled entries get no keys.** A constant entry
  is injected every turn regardless of what the message says, so a trigger word
  cannot make it fire any harder; a disabled entry never fires at all. Both are
  skipped and reported rather than having noise appended to the author's key list.
* **Entries with `keysecondary` (AND logic) are skipped** and flagged for manual
  review — an English primary matching your message while the Chinese
  secondaries only appear in AI text would shift activation timing.
* **Your decisions survive re-runs.** Entities are marked `provisional` while
  they still hold 扫描 placeholders; once classified or hand-edited, a re-run
  only *adds* aliases and never overwrites your `display_en`, `displayPolicy`
  or category.
* **Idempotent.** The `addedKeys` ledger plus a pre-write re-read means running
  it twice produces no second diff.
* **Fingerprint-guarded.** If the book changed between analysis and write, the
  write is refused rather than applied to a book that moved.

### Why it batches at all

A conversational worldbook call can put all 176 entries in one prompt, because
its *answer* is short. This pass is the opposite shape: it emits one JSON row
**per entry**, so the reply grows linearly with the batch. At roughly 80 output
tokens per row, a 176-entry book wants ~14k output tokens — well past any
ordinary cap, and an overrun truncates the array mid-row and makes the whole
reply unparseable.

So batch size is derived from the **output budget**, not picked by feel:
`floor(budget × 0.7 / 80)` — about 71 entries per call at the default 8192, so
a 176-entry book takes three calls. Raise `outputBudget` and batches grow with
it. Input is never the constraint: each entry contributes only its title, keys
and 300 characters of content.

Batches are also **self-healing**. If a reply comes back short (truncated, or
the model summarised instead of enumerating), only the *missing* entries are
requeued at half size — a bad reply costs those rows, not the batch. Failures
that survive the retry ladder are listed by entry rather than silently dropped.

Fixed renderings for cultivation jargon (炼气/筑基/金丹/元婴/化神/合体/渡劫) are
pinned in `setup/prompts.js` so a model can't invent "Foundation Building" on
one run and "Foundation Establishment" on the next — these become your permanent
typing vocabulary, so edit them there once if you want different wording.

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

### Display policy — and the names it asks you about

`displayPolicy: "en"` renders the English form; `"zh"` leaves the Chinese. The
rule of thumb is that *phonetic* names become English (沈慕微 → "Shen Muwei")
and *semantically meaningful* ones stay Chinese (天剑宗 stays 天剑宗).

Plenty of names sit on the fence. 归墟 is a real place name — so "Guixu" reads
fine — but it also literally means "where all things return to the void", so a
translation reads fine too. **The Setup Pass does not decide those for you.** It
marks them and asks:

* During setup, pending names appear at the top of the results as
  **需要你决定**, each showing both concrete forms — click the one you want.
* Any time afterwards, **🈳 名称显示** lists every switchable name with the same
  two-way toggle, so a decision is never final. Tick *只看待定的* to see only
  what is still unanswered.

A choice you make is latched: a later Setup Pass will never overwrite it or ask
about that name again, even if the model still thinks it is ambiguous. Names the
classifier is confident about are set without bothering you, and remain
flippable in the same panel.

**Single-hanzi names** (红, 陶, 瓷, 窑, 蛸) are a special case: a single hanzi
substring-matches ordinary prose (红 is both a character and the word "red", so
it hits 红色, 脸红, 红衣) and CJK has no word boundaries to anchor against.

* They are **never rendered in English** — no override. Renaming would corrupt
  the sentence every time the ordinary word appears
  (`她换上红色的外袍` → `她换上Hong色的外袍`).
* They are **not highlighted by default**. Set
  `"allowSingleCharHighlight": true` on that entity to get the underline and
  hover card back — a false highlight is only cosmetic noise.

This affects **display only**. Their World Info entries still fire on the
Chinese key exactly as the author configured them; LangBridge never touches
World Info matching.

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
