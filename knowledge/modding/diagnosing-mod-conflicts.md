# Diagnosing a Broken Bannerlord Mod Setup

Use this when the user says an installed mod "doesn't work", "broke", or the game
won't start — as opposed to asking for a new mod. The goal is to name a single
root cause with evidence, not to guess. Do **not** start by reinstalling things.

## 1. The single most useful artifact: the engine's own Command Args line

The launcher's `LauncherData.xml` records what the *user ticked*. That is not what
the game *loaded*. The engine writes the authoritative list into its own log:

```
C:\ProgramData\Mount and Blade II Bannerlord\logs\rgl_log_<pid>.txt
  [21:38:55.918] Command Args: /singleplayer _MODULES_*Bannerlord.Harmony*Bannerlord.ButterLib*...*_MODULES_ no_watchdog
```

Everything between `_MODULES_*` and `*_MODULES_` is the real, ordered load chain.
`no_watchdog` vs. the marker being absent is noise; the module list is the signal.

A paired `rgl_log_errors_<pid>.txt` holds that session's crash output. Pair by pid.

## 2. Classify each session honestly

Three outcomes, not two:

| Outcome | Test | Meaning |
|---|---|---|
| CRASH | `Unhandled Exception Code 0x...` appears in the errors log | process died on a fault |
| CLEAN | main log contains `Closing log file` | engine shut down gracefully |
| ABORTED | neither marker | killed / hung / user force-quit — **unknown**, not clean |

**The `ABORTED` case is the trap.** An empty errors file looks like success, but a
process that was killed before it could log anything also has an empty errors file.
Counting those as clean makes the "module present in every crash, absent from every
clean session" correlate point at the wrong mod. Real example: a session that loaded
the culprit module and got force-killed showed a clean errors log; only the missing
`Closing log file` marker revealed it wasn't a healthy run.

Also record `Build Version: <n>` per session. If it differs between sessions, the
game version changed mid-debugging and comparisons across those sessions are invalid.

## 3. Read the crash code

| Code | Meaning |
|---|---|
| `0xE0434352` | unhandled .NET (CLR) exception. Usually a mod's managed API no longer matches the game version, or a Harmony patch failed to bind. |
| `0xc0000005` | access violation. **Not necessarily native-only** — a `clr.pdb` + `MonoMod.Utils` stack means managed, patched code is on the faulting path. See below. |
| `0xe06d7363` | C++ exception crossing the CLR boundary. |

Then look for `MonoMod.Utils` frames in the stack. Their presence means the fault happened on a
code path running through Harmony's IL patch pipeline. There are **two distinct readings and they
must not be conflated**:

1. **A patch failed to bind** — a mod tried to patch a method that no longer exists or changed
   signature. Usually surfaces at *load* time, and is corroborated by log lines such as
   `PatchAll() failed: Patching exception in method …` (ButterLib / BannerWand emit these).
2. **A crash inside code that was patched successfully** — the frame is merely the trampoline a
   working patch leaves on the stack. Measured 2026-09-23: a `0xC0000005` with `MonoMod.Utils` at
   the stack bottom occurred **140 s into a mission**, and the log named **no** culprit mod.

A MonoMod frame narrows it to "some mod's patch is involved" — it does **not** by itself indict a
patch-binding failure specifically. Correlate against a clean session (§10) before blaming one.

## 4. Cross-check the disk and the manifest

For each folder under `Modules/`:

- **No `SubModule.xml` → the launcher cannot see the module at all.** It will be absent
  from `LauncherData.xml` and never loads. Seen in the wild: a translation-only package
  that ships just `ModuleData/Languages/<locale>/strings.xml` with no manifest, deployed
  as an effectively empty module. Harmless but dead weight.
- **A module whose `SubModule.xml` declares `DependedModule ... DependentVersion="v1.4.8"`
  is self-certifying.** That is the cheapest compatibility check available and should be
  read for every suspect.

### Vortex deployments on a different drive

When Vortex's staging folder and the game are on different drives, Vortex cannot
hardlink and falls back to **symlinks**. Consequences for diagnosis:

- `find <moddir> -type f` **follows nothing** and reports the folder as empty except for
  `__folder_managed_by_vortex` markers. This looks exactly like a failed deployment and is
  not one. Use `ls -la` (which shows the `->` targets) or `find -L`, and verify the link
  targets exist before concluding anything about deployment integrity.
- Editing files in the staging folder changes them in-game instantly (same bytes), so
  "redeploy" is unnecessary for content edits.

## 5. The version matrix beats any amount of log reading

Once a suspect is named, check the mod's own release notes for the **exact** game versions
it declares support for, and compare with `Modules/Native/SubModule.xml` → `<Version>`.
Some authors version-lock hard and document it explicitly ("ONLY COMPATIBLE WITH v1.2.0
only! (otherwise you will get hard crash)"). When the installed game version is outside
every published build's supported range, the mod is unfixable by repair — say so and
present the alternatives (drop it, downgrade the game, or wait) rather than attempting a
patch that cannot work.

Note the author's release-note wording can be ambiguous or mistranslated. Prefer the
changelog on the files page over a promotional blurb, and treat a controlled in-game
A/B test as the tie-breaker of record.

## 6. Run the analyzer

`scripts/diagnose_crash.py` automates steps 1–4:

```bash
python scripts/diagnose_crash.py --modules "<game root>/Modules"
python scripts/diagnose_crash.py --json    # machine-readable
```

It prints the session table, translates crash codes, names modules that appear in every
crashing session and no clean one, diffs `LauncherData.xml` against the actually-loaded
chain, and flags module folders with no manifest. Read-only.

## 7. What is *not* a cause (don't chase these)

- **Harmony patch-miss lines in ButterLib's own log.** ButterLib's `trace*.txt` /
  `butterlib*.txt` commonly contain
  `AccessTools2.Method: Could not find method for type '...CampaignBehaviorManager' and name 'OnGameLoaded'`.
  That comes from ButterLib's own `CampaignBehaviorManagerPatch` (the symbol is present in
  every one of its versioned implementation DLLs). It is benign noise. Confirm by checking
  whether the suspect mod's DLLs contain the symbol at all before blaming it.
- **`Couldn't find .dll: ...TaleWorlds.MountAndBlade.Platform.PS.dll` / `GDK.dll` etc.**
  These are expected on Windows — those platform assemblies ship only on console.
- **`Could not find the event index for: event:/...`** — audio bank noise, unrelated.
- **The launcher crashing as well as the game.** If a module's DLL throws while BLSE's
  launcher loads module assemblies (to register `BLSEExceptionHandlerAttribute` handlers),
  the launcher dies too. Windows event log entries for `Bannerlord.BLSE.Launcher.exe` are
  therefore useful corroboration, not a separate problem — check whether their timestamps
  fall inside the window when the suspect module was enabled.

## 8. Tool traps that silently produce wrong conclusions

Every entry below fails in the direction of "no result", which is indistinguishable from "the thing genuinely
is not there". **An empty check is a failed check, not a pass.**

| Trap | Symptom | Do instead |
|---|---|---|
| Content search returns nothing | ripgrep-class tools do not follow symlinks, so a scan under `Modules\<Mod>\` reports "No matches" although every file is present. Measured separately: one such tool returned **0 results for every pattern** against an ordinary, *non*-symlinked directory tree that other tools read fine | `Select-String` through the shell (it resolves symlinks), or read the file directly. **Never** conclude "the string is not in this mod" from a search miss |
| `Select-String` without an explicit encoding | silently mis-decodes non-UTF-8 files — this is how a `ModuleType` element was once "proved" absent | `Get-Content -Raw` plus a regex, or pass the encoding explicitly |
| Type-name case | searching `MbObjectManager` **misses**; searching `MbObject` **hits** — on a *different* real type, `MbObjectXmlInformation`. Either result alone confirms a wrong conclusion | Bannerlord managed types use the **`MB`** prefix. A hit is trustworthy; a **miss is not evidence** — change the name segment and re-run |
| `LauncherData.xml` schema | it is not a list of `<Module Id=…>`. Each entry is `<UserModData><Id>…</Id><IsSelected>…</IsSelected></UserModData>`, so a regex written for the former returns nothing — which reads like "file not found" even when the path is correct | Confirm the parse produced a **non-empty** list before reporting the file missing |
| `Remove-Item` no-op | returns success while the file remains; "cleanup done" is fiction | Re-list the directory after deleting |
| `reg.exe` | invoking it trips a sandbox blacklist that **kills the whole process** — not a catchable error | Never call it. Walk the filesystem instead — which is why `probe_game.py` finds installs by scanning drive letters |
| A `.ps1` whose working path contains non-ASCII | exits with code 1 and **no output at all**, which reads like "the script logic is wrong" | Keep scripts and their output on pure-ASCII paths |
| **Decompiled-source search** (any tool that ripgreps a `Source/` tree) | reports **0 hits** for a symbol that demonstrably exists, because the tree is **incomplete**. Measured: the tree held 10 core assemblies + 6 module assemblies and **omitted every `*ViewModelCollection.dll`** — so `Mission.SetFastForwardingFromUI` looked like it had **zero callers**, when in fact two ViewModelCollection assemblies call it. Conclusion "this API is dead code" was **wrong** | Never report "no callers" from a source-tree search alone. Confirm against the **assemblies** (see 8.1) before making any dead-code claim |

### 8.1 Binary symbol search — the authoritative fallback

A source tree can be incomplete; the **shipped assemblies cannot**. .NET keeps type names, method names and
member references as plaintext in the PE `#Strings` heap, and `ldstr` literals in `#US` — so an ordinary
text search over the DLLs is decisive:

```bash
cd "<game root>"
grep -r -a -l --include='*.dll' -e "SetFastForwardingFromUI" bin Modules
```

- A **hit** proves the symbol is present in that assembly (a caller, a definition, or both).
- Compare the hit set against the assemblies the source tree actually covers. Any assembly in the hit set
  **but absent from the tree** is exactly where the "no callers" conclusion was manufactured.
- Narrow a hit down (`grep -a -o -P '[\x20-\x7e]{0,50}<Symbol>[\x20-\x7e]{0,50}'`) to read the neighbouring
  `get_*` / `set_*` / type names — that is usually enough to name the owning type without a decompiler.
- Do **not** loop `find … | while read f; do grep …; done` over the whole game folder: spawning one grep per
  DLL is slow enough to be **killed by timeout**. One recursive `grep -r` is orders of magnitude faster.
- **But do not trust a recursive `grep -r` either — verify a "no hits" with a second method.** Reproduced on
  `Modules\RTSCamera`: `grep -r -a -o -P '<pattern>' Modules/RTSCamera` returned **0 hits for every pattern
  with exit code 0**, while `grep -a -o '<pattern>' …/RTSCamera.dll` (per-file) returned **14 hits** on the
  same bytes. Vortex-managed module trees (`__folder_managed_by_vortex`) are the worst offenders, but the
  failure mode is the same everywhere: *a silent empty result is indistinguishable from a real absence.*
- **The reliable middle ground: `find … -exec grep … {} +`.** This hands *many* files to each grep process
  (unlike `-exec grep … {} \;`, which spawns one per file and risks the timeout noted above), while still
  enumerating the files itself instead of trusting a recursive directory walk — which is precisely what
  breaks on Vortex trees. Measured 2026-09-23 over a 40-mod tree that included Vortex-managed modules: it
  returned the correct **and complete** hit set for both `Silk.NET` (1 assembly) and `MonoMod` (13
  assemblies), where the recursive scan had under-reported `SetFastForwardingFromUI` to 4 of 13. Prefer this
  over both `grep -r` and one-process-per-file loops:

## 9. Reporting

Give the user: the root cause, the evidence table (session → version → enabled modules →
outcome), what was ruled out and how, and the alternatives with their costs. If the setup
currently works, say that plainly — do not imply urgency when nothing is broken.

## 10. Crashes mid-mission: the differential test, and CrashReport as a confounder

When the crash happens **after the game has been running** (a battle, a scene load) rather than
at startup, the fastest way to shrink the search space is a **differential test against the last
clean session** — not more reading of the crashing log.

**The differential test.** Every session writes its own `rgl_log_<pid>.txt`. Take the most recent
session that ended **normally** as baseline, and diff a cheap, stable signal against the crashing
one — the `Resolving:` lines work well:

```bash
for f in <logs>/rgl_log_<clean>.txt <logs>/rgl_log_<crash>.txt; do
  printf '%s: %s\n' "$(basename "$f")" "$(grep -c 'Resolving:' "$f")"
  grep -o 'Resolving: [A-Za-z0-9_.]*' "$f" | sort -u | head
done
```

Measured 2026-09-23: clean session = 14 `Resolving:` lines, all `*XmlSerializers`; crashing
session = 18, including **four `Silk.NET.*`**. The difference set named the anomaly in one step.
Also diff the *noise* (`grep -c` a recurring error in both): a message appearing **equally in
both** sessions is not the cause, however alarming it looks (that day, 62 identical
`town_edge_number` XML errors in each — a red herring).

**CrashDumper's files, and what each one actually holds.**

| File | What it is |
|---|---|
| `default<date>.log` | **NOT** the engine log — it is **BUTR.CrashReport's own activity log**. Content *before* the crash means CrashReport itself ran (decompiling assemblies, resolving references). Its timestamps tell you when a crash report was generated. |
| `crash_tags.txt` | Tag dump. The `[Runtime][Arguments]` line holds the full `_MODULES_*…*_MODULES_` launch chain — the fastest single source for the loaded-mod list. |
| `rgl_log_<pid>.txt` | The engine log. `grep '^\[HH:MM'` gives a timed trace; a gap with **no lines** is a stalled main thread, not a quiet log. |
| `logs/rgl_log_errors_<pid>.txt` | Exception code + call stack only. |
| `dump.dmp` (100 MB+) | Full minidump. **Useless without a debugger** — needs `cdb.exe` (Windows SDK) or Visual Studio. Check `ls "C:/Program Files (x86)/Windows Kits/10/Debuggers/x64/cdb.exe"` first; if absent, say the dump can't be resolved rather than implying it will answer the question. |
| `crashes/<timestamp>/` | **The number of these directories is the crash history.** Exactly one ⇒ this was the *first* crash — itself strong evidence when comparing sessions. |

**CrashReport can be part of the incident, not merely the reporter.** Measured 2026-09-23: 0.8 s
after a mission began, `default<date>.log` showed CrashReport decompiling methods
(`MethodDecompiler.DecompileCSharpCode`; `ReferenceImporter` throwing `NotSupportedException` /
`InvalidOperationException`); 4 s later its ImGui renderer resolved `Silk.NET.Windowing.Glfw`/`Sdl`
+ `Silk.NET.Input.Glfw`/`Sdl`; then the main thread went silent for **140 s** and died with
`0xC0000005`. The only assembly in the whole `Modules/` tree referencing `Silk.NET` was
`Bannerlord.ButterLib/…/BUTR.CrashReport.Renderer.ImGui.dll`.

⇒ When you see this pattern, working hypothesis: **something threw in-mission; CrashReport tried
to build an ImGui window (which needs a GLFW/SDL context) inside a scene where the engine owns
the GL context, and that collided.** The *original* exception — which may never reach
ButterLib's log — is then the root cause, while the crash stack shows only CrashReport's own
machinery. Look for it in `default<date>.log`, not in the engine log.

**Isolating a suspect when a mod drove the scene.** If a mod programmatically started the mission
(a custom scenario), change **one** variable per run: same scene started **manually** by the
player; then with any speed-up disabled; then with each patch-heavy mod disabled in turn; then
with the suspect mod disabled entirely. Only the last of these can exonerate it. And note that a
programmatically assembled mission may simply be **missing an initialisation step** the normal
path performs — a plausible independent cause, which also explains "the UI is there but the
button does nothing".

Finally, clear a mod on its own evidence before assuming it: scan its DLL for patch-library use
(`grep -c -a 'Harmony\|MonoMod\|0Harmony' <Mod>/bin/Win64_Shipping_Client/<Mod>.dll`). A mod that
returns **0** on all three does not patch, so `MonoMod.Utils` frames in a crash stack do not come
from it — a cheap, decisive exoneration.
