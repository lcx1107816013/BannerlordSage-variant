# BUTR stack and localization judgement

Supplementary to `module-layout-and-schema.md` and to the localization branch in `SKILL.md`.
Everything here is the part of the picture that lived outside the skill's original scope:
upstream provenance, pack governance, the pre-flight gate that decides whether the later
classification means anything at all, and one asymmetry that settles whether a visible string
is translatable in principle.

## Upstream provenance — check before recommending a fix

The four "prerequisites" are maintained by a single GitHub organisation, **`BUTR`**
(`BUTR/Bannerlord.ButterLib`, `BUTR/Bannerlord.Harmony`, `BUTR/Bannerlord.UIExtenderEx`;
`BUTR.CrashReport` is a related satellite). Practical consequence: when a report smells like a
framework-layer defect, the fix may already have shipped in a newer build — check the
organisation's releases for the module in question **before** proposing a Harmony patch that
the user would have to redo on every upstream release.

## Do not edit BUTR's own Chinese packs in place

BUTR's translations are managed through **Weblate** (`translate.butr.link`), and the language
files carry a header stating they are Weblate-managed and that hand edits will be overwritten.

So a correction to a BUTR pack must be delivered as a copy outside the game directory. This is
the same deployment hazard as the Vortex-managed module folder, with a second cause stacked on
top: a Vortex purge/redeploy removes it, *and* upstream Weblate regeneration replaces it.

That is not a reason to avoid touching BUTR packs — it is a reason to hand over a file the user
can re-apply, rather than an edit they will lose without noticing.

## The pre-flight gate — pass this before judging localizability

Before classifying any visible English, establish that the localization channel is open at all.
Five mechanical checks; a failure at any one of them makes the later classification meaningless:

1. The pack files exist at the path the module's `language_data.xml` declares.
2. `language_data.xml`'s `id` matches the language actually selected in game
   (`BannerlordConfig.txt` → `Language=`).
3. The engine log (`rgl_log_<pid>.txt`) shows the file **was opened**.
4. The error log (`rgl_log_errors_<pid>.txt`) has no parse error for it.
5. The pack file's mtime predates the game session being judged.

Only when all five pass does "the pack is fine, so this is a content question" become valid.
Skipping the gate is how a stale or unregistered pack gets misdiagnosed as hardcoded English —
on screen the two are indistinguishable.

## The `Id` / `Name` asymmetry

On a BUTR mod-options page, group titles are the literal `"SubSystem "` concatenated with a
subsystem's **`Id`**, and every `Id` is a bare string carrying no `{=KEY}` marker. But the
adjacent **`Name`** property of that same subsystem *is* localizable — for example
`{=Ox6uK8fZWs}Distance Matrix` resolves to 「距离矩阵」.

So a group title reading English is **not** evidence that the subsystem has no translatable
name. One property was used where another was already available. That changes the honest answer
to "can this be fixed?" from *"no key exists to translate"* to *"the key exists and is never
requested"* — the translatable data is sitting right there, unused.

It does not make the fix cheap: a Harmony patch against the getter is still per-release work
with a real cost (and rewriting `Id` can invalidate saved settings). The point is to state the
cause correctly, not to imply an easy win.

## What is inference, not measurement

Class 2 ("keyed strings that render their default text") has a **proven symptom** and an
**unproven mechanism**. Keep them apart when reporting.

**Proven:**

- The `Options.json` tell — `Configs\ModSettings\<ModuleId>\<Page>.json` keys are the
  marker-stripped English text and never contain CJK, even on a Chinese install.
- The affected strings are covered by an installed pack, with no engine error.

**Inference:**

- That a `TextObject.ToString()` evaluated at registration time caches the English default.
  The supporting evidence is circumstantial — the implementation assembly loads (~19:39:05.75)
  *before* the language tables (~19:39:09.2), which is compatible with the hypothesis but does
  not demonstrate it. The specific call site has **not** been decompiled and verified.

Report the symptom as fact and the mechanism as the leading hypothesis. The recommended action —
do not attempt a language-pack fix — is identical either way, so the uncertainty costs the user
nothing. Stating an unverified mechanism as settled is how a wrong explanation gets inherited
by the next diagnosis.
