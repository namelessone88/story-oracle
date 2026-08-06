# LangBridge · 触发词桥

A standalone SillyTavern extension that does exactly two things:

1. **⚙️ 翻译触发词** — a one-time pass that translates the Chinese trigger
   words of your worldbook's **green (keyword-triggered) entries** into
   English and appends them as extra keys — so typing English fires the
   entries. Blue (constant) entries are skipped: they inject every turn
   anyway, so a trigger word buys them nothing.
2. **Highlighting while you play** — trigger words get a subtle dotted
   underline in the chat; hover (or tap) one to see which entries it can
   trigger, their sibling trigger words, and **the English ways to type it**.

Nothing else. No per-turn LLM calls, no input transformation, no rewriting of
what's on screen — the chat file and the rendered text stay exactly as the
model wrote them.

> Earlier versions (≤0.4.0, in git history) also renamed Chinese names to
> English on screen, classified entries into categories, asked for display
> decisions, and cross-checked a drawing library. All of that was cut in
> 0.5.0 as out of scope. If any of it is ever wanted again, it exists at tag
> `v0.4.0`-era commits — don't rebuild it from scratch.

---

## Guarantees

| | |
|---|---|
| **I1** | Never modifies `message.mes` or the chat file — highlighting is DOM-only and byte-exactly reversible |
| **I2** | Zero per-turn LLM calls — the model is used only in the on-demand translation pass |
| **I3** | The worldbook is only ever **appended to**: original keys, `keysecondary`, `constant`, flags, content and comments are never touched |
| **I4** | No runtime input transformation — typed English fires World Info because the keys are really in the book |
| **I5** | Never breaks the host — every SillyTavern touchpoint feature-detects and degrades (worst case: highlight-only or idle, with an honest notice) |

## Install

Copy `langbridge/` to
`SillyTavern/public/scripts/extensions/third-party/langbridge/`, reload, and
find **LangBridge · 触发词桥** under Extensions.

Prerequisites (outside this extension): your preset must not force English
names in output (the model writes Chinese, so Chinese keys keep firing), and
global World Info "Match whole words" must be OFF — necessarily already true if
Chinese keys work at all.

## Use

1. Pick your worldbook, press **扫描** — builds the entry index (titles, keys,
   green/blue flags). No AI, nothing written.
2. Press **⚙️ 翻译触发词** — pick a generation channel (a cheap Connection
   Profile, or follow your main API), run, review exactly what would be
   appended, then write. Re-running later is safe: results are cached, writes
   are diffed, and the `addedKeys` ledger makes the whole thing idempotent.
3. Play. Underlined words are triggerable; hover to see what they trigger and
   how to type them in English. Turn on 「也标出我自己发的消息」 to spot gaps:
   an English phrase that doesn't light up has no key yet.

`sample-registry.json` can be imported to see both features working before
touching your own book.

## What the translation pass does (and refuses to do)

* **Translates the author's own words, per entry** — the entry keyed
  传送阵 / 传送费用 / 购买力 / 灵石价格 / 跨域传送 / 路费 gets an English
  sibling for each, not a few invented phrases. Names get pinyin plus a
  given-name-only form (沈慕微 → "Shen Muwei", "Muwei"); titles are translated
  too (无情道首座 → "Merciless Path First Seat").
* **Screens every candidate** against a code/UI vocabulary blocklist and
  against your card's actual status-bar templates, variable lists, and a real
  sample AI reply. The World Info scanner reads the raw message *including*
  MVU blocks and status-bar HTML, so a key like `level` would fire every
  single turn — it gets rejected; `cultivation level` survives.
* **Skips what can't benefit**: blue (constant) and disabled entries, and
  entries using `keysecondary` (AND logic — an English primary could shift
  their activation timing; they're listed for you to handle by hand).
* **Batches by output budget, self-heals**: batch size is derived from the
  output token budget (the reply is one JSON row per entry, so output — not
  input — is the constraint). A truncated reply requeues only the missing
  entries at half size; entries that still fail are reported by uid, never
  silently dropped. Everything is cached by entry-content hash, so re-runs and
  resumed runs cost nothing for unchanged entries.
* **Pinned jargon**: the cultivation-stage renderings (炼气/筑基/金丹/…) are
  fixed in `setup/prompts.js` so two runs can't produce two different
  spellings of your permanent typing vocabulary. Edit them there once if you
  want different wording.

## Honest semantics of the hover card

The card says an entry **can** be triggered — never that it fired. Actual
injection depends on scan depth, probability rolls, cooldowns and token
budget, which this extension cannot see. Single-hanzi keys (红) are excluded
from *highlighting* — a lone hanzi substring-matches ordinary prose (红色,
脸红) and CJK has no word boundaries — but they still get *translations*
("Hong"), because the English side does have word boundaries.

## Tests

```sh
sh langbridge/run-tests.sh
# DOM suite needs jsdom (dev-only): LB_JSDOM=/path/to/node_modules sh langbridge/run-tests.sh
```

162 tests across five suites: the matcher (longest-first — 东海海域 must beat
东海; ASCII word boundaries without regex lookbehind; CJK without boundaries),
token derivation (green-only, single-hanzi exclusion, English only on the user
side), the collision screen, tolerant JSON parsing, the self-healing batch
runner, plan idempotency, and DOM invariants (unchanged visible text,
idempotent passes, byte-exact strip, skip-list).

## Still to verify against a live SillyTavern

Marked `VERIFY` in source; all degrade rather than break:

1. `/scripts/world-info.js` export names on your ST version (scan/write paths).
2. Whether `saveWorldInfo` makes new keys live in the current session or a
   chat switch is needed first.
3. Exact event names (string fallbacks + a MutationObserver cover drift).
4. Real container selectors for MVU / status-bar / LWB regions to extend the
   skip-list in `runtime.js`.
5. Phone UX for tap-to-open cards; long-chat performance with highlighting on.
