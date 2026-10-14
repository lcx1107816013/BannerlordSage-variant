---
name: bannerlord-mod-dev
description: Author, modify, validate, and troubleshoot Mount & Blade II Bannerlord modules (mods) against an installed game copy — locating the install, mapping the version-specific ModuleData schema, writing SubModule.xml and XML data-table overrides, adding troops/items/cultures/parameters, shipping localization, statically validating every cross-table ID reference before launch, and diagnosing crashes or "my mod broke / won't load" reports from the engine's own logs. This skill should be used when the user asks to make, edit, fix, inspect, or explain a Bannerlord mod, reports that an installed mod is broken or the game crashes on startup, or mentions spnpccharacters.xml, spcultures.xml, SubModule.xml, the Modules folder, BLSE, Harmony/ButterLib, Vortex, rgl_log, or XML overrides for Bannerlord.
agent_created: true
---

# Bannerlord Module Development

## Purpose

Bannerlord modding is schema-driven XML work layered onto a versioned, partly undocumented
engine. The two failure modes that cost the most time are (1) guessing a data table's schema
or file location instead of reading it, and (2) hand-transcribing item/troop IDs, which
produces silent load failures. This skill establishes the correct order of operations:
**locate the install → read the real schema → generate → validate every cross-table ID →
only then tell the user to launch.**

Never write a Bannerlord mod from memory. Table locations, tag shapes, and even whether a
table exists at all change between game versions.

## Branch: "my mod is broken / the game crashes" ≠ "make me a mod"

If the user reports that an **already-installed** mod doesn't work, that the game won't
start, or that a mod "broke", do **not** begin the authoring workflow and do **not**
reinstall anything. Run `scripts/diagnose_crash.py` first and read
`references/diagnosing-mod-conflicts.md`.

The engine records the only authoritative list of what actually loaded — the
`Command Args: ... _MODULES_*A*B*C*_MODULES_` line in
`C:\ProgramData\Mount and Blade II Bannerlord\logs\rgl_log_<pid>.txt` — not `LauncherData.xml`,
which only stores what the user ticked. Pair each such log with its
`rgl_log_errors_<pid>.txt` to get a per-session "which modules were loaded / did it crash"
table. Sessions where the chain differs by exactly one module and the outcome flips are the
whole diagnosis.

Two rules that decide whether that table tells the truth:

- **A session with no crash record is not automatically a healthy run.** Only
  `Closing log file` in the main log proves a graceful exit; otherwise the process was
  killed and the outcome is unknown. Treating those as clean misattributes the cause.
- **A module folder that looks empty is usually a Vortex symlink deployment, not a failed
  one.** `find -type f` does not follow symlinks; cross-drive Vortex staging always
  produces symlinks. Verify with `ls -la` and check the link targets before claiming a
  deployment is broken.

And the rule that ends most of these cases fast: **check the mod's published version matrix
against `Modules/Native/SubModule.xml`.** Bannerlord mods are commonly hard-locked to one
minor game version, and authors say so in their release notes. If no published build of the
mod supports the installed game version, it cannot be repaired by editing files — report
that and give the alternatives instead of attempting a patch.

**But a version mismatch is not the only cause of "patch failed", and not even the most
common one.** Before concluding "incompatible build", rule out a *second mod replacing the
game model the first mod patches*. Two C# mods that both touch the same `GameModel` are a
hard conflict and the messages look exactly like a version break:

- A mod may register its own model via `IGameStarter::AddModel<TModel>` in `SubModule::AddModels`,
  replacing vanilla's. If that replacement class **inherits the abstract base directly**
  (e.g. `XAgentStatCalculateModel : TaleWorlds.MountAndBlade.AgentStatCalculateModel`) instead
  of inheriting the concrete vanilla implementation (`SandBox.GameComponents.SandboxAgentStatCalculateModel`),
  every **non-abstract helper** of the concrete class disappears from the runtime type.
- Symptom: the patch mod resolves its target by name at runtime (see below), fails, and prints
  its own diagnostic on every game start. Those diagnostics are shown **in-game only** — they
  are usually absent from `rgl_log_*.txt`, so "not in the log" does not mean it did not fire.
- Verify with the type-chain scan in the technique below. `NavalDLC` also ships
  `NavalAgentStatCalculateModel` / `NavalCustomBattleAgentStatCalculateModel` the same way,
  but those only apply in naval missions — do not blame them for a campaign-map message.

**Confirm against the author before theorising.** For popular mods the exact error string is
usually already answered in the mod's Steam Workshop discussion tab or its
`bbs.mountblade.com.cn` thread — search the literal localised message. In the observed case
the author's own reply ("another mod has overridden the model I look for") plus a user's
"works with mine alone" reply closed the issue in one search.

### Technique — read a C# mod's real patch targets and lookups

Read the assembly metadata with **`Modules/Bannerlord.Harmony/bin/Win64_Shipping_Client/Mono.Cecil.dll`**
(also present in the mod's own `bin/`, and in `ButterLib`). Cecil reads metadata directly and
needs **no dependency resolution**, which is why it works where reflection does not:

- Enumerate `type.CustomAttributes` where `AttributeType.Name -like '*HarmonyPatch*'` and read
  `ConstructorArguments` — a `Type` argument arrives as an assembly-qualified name string
  (e.g. `TaleWorlds.MountAndBlade.AgentStatCalculateModel, TaleWorlds.MountAndBlade, Version=…`),
  which is itself the tell that the attribute took a `typeof(...)`.
- A patch class with an **empty** `[HarmonyPatch]` plus `Prepare()` / `TargetMethod()` /
  `static MethodBase TargetMethod()` resolves its target at runtime — dump the IL of those two
  methods (`method.Body.Instructions`, `Operand.ToString()`) to see the literal method names it
  searches for. `Prepare()` returning `false` (or setting an `InjectionFailed` flag) is what
  produces the user-visible failure message.
- For "who replaced the model", scan every module DLL for types whose `BaseType` chain contains
  the model name, and for `AddModel<…>` / `GameModel` call operands.

**Cecil needs a .NET host, and this machine has none.** `csc.exe` and `Add-Type` are both blocked
as security controls (see §Sandbox Limits), and Cecil is a .NET assembly, so the recipe above is
not runnable here. Use **`scripts/netmeta.py`** instead — a zero-dependency pure-Python PE + CLI
metadata reader (TypeDef / Field / MethodDef tables and the `#Strings` heap). It answers the same
question without loading any .NET code:

```python
from netmeta import NetMeta
m = NetMeta(r"...\Modules\Bloodlust\bin\Win64_Shipping_Client\Bloodlust.v1.4.8.dll")
for d in m.typedefs():
    print(d["ns"] + "." + d["name"], "extends", m.decode_extends(d["extends"]))
```

### Technique — wrapper vs patcher is the whole answer, and it is decidable from metadata

Given one base type (here `AgentStatCalculateModel`), every mod touching it falls into exactly one
of two classes, and the two behave oppositely under load order. Read them off the TypeDef:

| | **Registrant (wrapper)** | **Patcher** |
|---|---|---|
| `extends` | the model base type itself | `System.Object` |
| fields | `_previousModel` (or `_model`) — delegates to the prior instance | only compiler-generated `<>…` iterator fields |
| methods | the base type's own members, overridden wholesale (`UpdateAgentStats`, `GetEffectiveSkill`, …) | `TargetMethod` / `TargetMethods`, `Prefix`, `Postfix`, `Transpiler`, `Finalizer` |
| load order | **matters** — last `AddModel` wins | **irrelevant** — patches the method definition |

Verified on this install (2026-09-26):

- `BloodLust.models.BloodlustAgentStatCalculateModel` — extends `TaleWorlds.MountAndBlade.AgentStatCalculateModel`,
  field `_previousModel`, 22 overridden methods. A genuine wrapper; it delegates, so every patch
  targeting the *original* concrete class still executes.
- `RealisticWeather.GameModels.RealisticWeatherAgentStatCalculateModel` — extends `System.Object`,
  methods are only `TargetMethods`/`Postfix`/`Transpiler`/`Finalizer`. **A patch class, not a
  model.** The name is a trap: it made a string-heap scan look like `AddModel` on this type. Its
  real registered models are `…PartySpeedModel`, `…PartyMoraleModel`, `…MapVisibilityModel`,
  `…BattleMoraleModel`.

**Consequence — and the thing to check before writing any compat shim:** a correct wrapper +
a static patcher already compose. No shim is needed. The *only* combination that breaks is a
**runtime-lookup** patcher (`GetTargetModelMethod`, `MissionGameModels.Current`) that resolves
the *instance* type at runtime: the wrapper's type does not carry the original concrete class's
private helpers, so `GetMethod("UpdateHumanStats")` returns null. `BloodlustAgentStatCalculateModel`
has 22 methods and `UpdateHumanStats` is **not** among them — that is exactly why
`WarbandlordBloodlustFix` exists. So: classify first, then decide. Never write a shim on the
assumption that two mods touching one model must conflict.

### Technique — scope the blast radius before telling the user how bad it is

After identifying a patch that fails, the "how much does this actually cost me?" question has a
mechanical answer. Do not speculate; four checks settle it:

1. **The failure messages enumerate themselves.** In Warbandlord every runtime-lookup patch has
   its own `Prepare()` that sets the `PatchName` text variable and prints `PatchFailedMsg` in red
   when `TargetMethod()` returns null. Write a small Cecil loop over every class that has a
   `TargetMethod()` and check whether its `Prepare()` contains a `DisplayMessage(msg, Color::Red)`
   call — then count the red lines the user actually saw. Here that counted **2 of 14** lookup
   patches, which kills the hypothesis "and probably more broke silently".
   There is also a structural argument for the same conclusion: `MissionGameModels.Current` is assigned
   only in `MissionGameModels..ctor` and nulled by `MissionGameModels.Clear` from
   `MBGameManager::OnGameEnd` — i.e. it is non-null for as long as a Game (campaign or battle) is live.
   Every runtime-lookup patch reads `MissionGameModels.Current?.Model`, and `GetTargetModelMethod`
   returns null immediately when the model is null. So if `Current` were null at resolution time, *all*
   such patches would fail together. "Only two failed" therefore proves the lookup ran with a live
   model, and the cause must be per-target (the model chain), not environmental.
2. **Two patch-wiring styles have wildly different blast radius.** Method-level
   `[HarmonyPatch(typeof(EngineType), "Method")]` + `[HarmonyPrefix]`/`[HarmonyTranspiler]`
   targeting an engine **static** type (e.g. `MissionCombatMechanicsHelper.ComputeBlowDamage`,
   `MissionCombatMechanicsHelper.GetAttackCollisionResults`, `Mission.MissileHitCallback`) never
   touches a model *instance* and is therefore **immune** to another mod replacing the model.
   Only class-level bare `[HarmonyPatch]` + `TargetMethod()` reading `MissionGameModels.Current`
   is vulnerable. Check both before predicting damage.
3. **"Overrode the model" ≠ "every patch on that model dies."** Because the lookup uses
   `DeclaredOnly` from the runtime type upward, it *succeeds* whenever the replacement type
   re-declares the searched name. Members that are virtual on the abstract base are necessarily
   re-declared by the override, so they are found: verified on Bloodlust's `UpdateAgentStats`
   chain — `GetHorseChargePenetration`, `GetDamageMultiplierForBodyPart`,
   `CalculateRemainingMomentum` and `DecideWeaponCollisionReaction` are all declared on
   `BloodLust.models.*` and their Warbandlord patches still attach. The failures were exactly
   `UpdateHumanStats` / `UpdateHorseStats` — *private helpers of the Sandbox concrete class*, not
   part of the abstract contract, hence never present on a replacement that derives from the base.
   That distinction — abstract-contract member vs. concrete-class private helper — is the whole
   rule.
4. **Compensation check, for the two that did die.** Dump the `AgentDrivenProperties::set_*`
   operands in the lost postfix bodies (`MountSpeedModify::ModifyMountSpeed` →
   `MountSpeed`, `MountChargeDamage`; `HumanMovementSpeedModify` / `HumanWeaponSpeedModify` /
   `ShieldSizeModify` / `AIRelatedPropertiesModify` → `MaxSpeedMultiplier`,
   `CombatMaxSpeedMultiplier`, `TopSpeedReachDuration`, `ReloadMovementPenaltyFactor`,
   `SwingSpeedMultiplier`, `ThrustOrRangedReadySpeedMultiplier`, `ReloadSpeed`,
   `AttributeShieldMissileCollisionBodySizeAdder`, `AiKick`,
   `AiRangedHorsebackMissileRange`), then scan the *competing* mod for writes to the same field
   names. Bloodlust's `BloodLust.helpers.MissionHelper` writes `MaxSpeedMultiplier`,
   `CombatMaxSpeedMultiplier`, `SwingSpeedMultiplier`, `ThrustOrRangedReadySpeedMultiplier`,
   `ReloadSpeed`, `MountSpeed`, `MountChargeDamage` — i.e. it occupies the same slots, so the real
   loss is "these values now come from Bloodlust's formulas, not Warbandlord's", not "the feature
   is missing". What has **no** counterpart is shield missile-collision size and the two AI
   properties — those are the genuine net loss. Report the two categories separately.
5. **Check for the "wrapper model" pattern — it changes the verdict from "unfixable" to "one-line fix."**
   A model-replacing mod may *not* replace the logic at all: it may keep the previous model in a field
   and delegate. Installed case: `BloodlustAgentStatCalculateModel` has a single field
   `private AgentStatCalculateModel _previousModel`, and `UpdateAgentStats` opens with
   `callvirt AgentStatCalculateModel::UpdateAgentStats` **on that field** (`ldarg.0; ldfld _previousModel`
   then `ldarg.1; ldarg.2; callvirt`), then adds its own tweaks. So `SandboxAgentStatCalculateModel.UpdateHumanStats`
   / `UpdateHorseStats` **do run at runtime** — the patch target exists and is live. Never conclude
   "no call site to hook" without dumping the override's first instructions to see *whose* method it calls.
   Two details in this case defeat a lookup that has a perfectly good fallback:
   - The wrapper's field is declared as **exactly** the base type, and Warbandlord's fallback predicate is
     `field.FieldType != typeof(T) && typeof(T).IsAssignableFrom(field.FieldType)` — it excludes the most
     natural form of the pattern (a field typed exactly `T`).
   - The wrapper built itself with `Activator.CreateInstance(typeof(TModel), previousModel)` +
     `gameStarter.AddModel(GameModel)` (non-generic), so `MBGameModel<T>.BaseModel` stays `null` —
     and `BaseModel` is the fallback's *second* channel (`AccessTools.Property(typeof(T), "BaseModel")`,
     a non-public property declared on the generic base).
   **Repair recipe (no DLL editing, no reimplementation):** a ~100-line shim module that, in `OnGameStart`
   (after both mods, via `DependedModuleMetadata order="LoadBeforeThis"`), finds the wrapped instance by
   scanning instance fields of types assignable to `T` while walking `model.GetType()` → `BaseType`
   (**do not hard-code `_previousModel`** — scan by type so mod updates survive), then writes it through
   the non-public `BaseModel` setter found by walking base types manually
   (`GetProperty(name, Instance|Public|NonPublic|DeclaredOnly)` + `GetSetMethod(true)`; inherited
   non-public properties are NOT returned by a plain `GetProperty` call on the derived type).
   The patches then bind to the genuine, executing methods — transpiler anchors, `__instance` and
   insertion points all come out exactly as on a Bloodlust-free install. This beats reimplementing the
   lost effects (an earlier draft recommended a postfix that re-called the mod's own worker methods —
   workable, but it changes ordering and leaves the red text).
6. **Alternative repair: prefix the failing mod's own `TargetMethod()` (no object state touched).**
   Instead of writing `BaseModel` (option 5), install a Harmony prefix on each patch class's
   `TargetMethod()` that resolves the target yourself and returns it:
   ```csharp
   static bool Prefix(ref MethodBase __result) {
       var m = ResolveModelMethod("UpdateHumanStats");   // your own resolver
       if (m == null) return true;   // let the original run -> its red message still tells the truth
       __result = m; return false;   // skip original, Harmony uses __result
   }
   ```
   **You only need this one hook — do not also patch `Prepare()`.** Verified by disassembling
   0Harmony 2.4.2 `HarmonyLib.PatchClassProcessor::Patch()`: it calls
   `RunMethod<HarmonyPrepare,bool>` **first** (false ⇒ Cleanup + `ReportException` + return), and only
   then `GetBulkMethods()` → `RunMethod<HarmonyTargetMethods,…>` → `RunMethod<HarmonyTargetMethod,MethodBase>`
   (reflection `Invoke`). Typical mods implement `Prepare()` as `return TargetMethod() != null;` — so a
   non-null result from your prefix makes `Prepare()` pass on its own. Patching `Prepare()` as well would
   *hide* genuine failures.
   Note: in Harmony 2.4+ these special methods are located via **marker types**
   (`HarmonyLib.HarmonyPrepare` / `HarmonyTargetMethod` / `HarmonyTargetMethods` / `HarmonyCleanup`), not
   string literals — grepping `0Harmony.dll` for `"TargetMethod"` finds nothing; search the IL for
   `ldtoken HarmonyLib.HarmonyTargetMethod` instead.
   Choose between 5 and 6 by failure mode: 5 breaks if the mod changes its lookup logic, 6 breaks if it
   renames the patch class. Provide your resolver with a static-scan fallback (walk every loaded
   assembly for a type deriving from the base model that declares the method, preferring the game's
   `SandBox` assembly) so that a null `MissionGameModels.Current` — the one condition under which the
   original lookup fails for *all* its patches — still resolves.

Two approaches that **silently give wrong answers** on Bannerlord assemblies — do not use them:
`Assembly.LoadFrom` + `GetTypes()` (throws `LoaderExceptions` and you get a partial or empty
type list with no error), and a Harmony reflection probe compiled with `Add-Type` in PowerShell
5.1 (returned NULL even for members confirmed present). For a runtime name-resolved lookup,
intersect the mod's string literals with the member names of the installed game assemblies
instead — the hit set is the candidate target list.

## Branch: "what mods do I have installed / sort my load order"

Run `scripts/list_load_order.py`. It is read-only and emits a Markdown report plus JSON:
the full module inventory, a dependency-sorted recommended order, a diff against the
launcher's stored order, and a risk list. Read
`references/load-order-and-mod-inventory.md` before interpreting or advising on the
result.

Four conclusions that reference file exists to prevent:

- **Do not assume `Native` loads first.** The four community base libraries
  (`Harmony → ButterLib → UIExtenderEx → MCM`) precede it. That is correct.
- **Do not present a re-sort as a repair.** The engine enforces declared
  `DependedModules` regardless of the displayed order, so reordering can never fix a
  missing dependency. Only genuinely unconstrained modules can be moved at all, and for
  those the existing arrangement usually should be left alone.
- **The highest-value finding is usually "installed, ticked, but never actually run."**
  Compare module folder mtimes (second resolution) against the newest log containing a
  `_MODULES_` chain. That is invisible from `LauncherData.xml` alone.
- **Its risk list is a heuristic, not a verdict.** "Data table override conflict" fires on a
  shared table *name*, while real collisions are per-ID. Validate at ID level before letting
  the flag drive ordering advice, and ignore `<XmlNode>` blocks that are commented out — a
  naive scan counts them as live registrations. In an observed install both such flags for
  the module in question were false positives and its position was genuinely unconstrained,
  so the useful answer was "order is free; put it last as a convention", not a fake rule.

`LauncherData.xml` uses `<UserModData><Id>…</Id><IsSelected>…</IsSelected></UserModData>`
blocks, **not** `<Module Id="…">`. A regex for the latter returns nothing, which reads
exactly like "file not found" even when the path is right — confirm the parse produced a
non-empty list before reporting the file as missing.

## Branch: "can mod X join my current mod list?"

"Can I add X to *my* game" is not "does X work on my version". Five checks, cheapest first,
and stop at the first hard failure:

1. **Version gate.** `<root>/Modules/Native/SubModule.xml` → `<Version>` against the newest
   published file of the mod's *matching* branch (a `1.4.x.x` file for a 1.4.x game). When the
   Nexus Files tab is gated, the Chinese repack page's version matrix line
   (`1.4.x.x 支持游戏本体 1.4.x 版本`) is a transcription of the file list and is as good as it.
   A file whose version *equals* the installed game version is the clean case — say so, because
   it removes an entire risk category.
2. **Prerequisite gate.** Diff the mod's requirements against the *installed* module list and
   report "4/4 already satisfied, 0 new dependencies", not "needs prerequisites".
3. **Was it ever here?** Grep every `rgl_log_*.txt` for the candidate's module id or folder name.
   **Zero hits across all sessions = never installed** — no stale deployment, no leftover config,
   no partial-deployment artifact to explain. One command that kills a whole class of speculation.
4. **Overlap surface, not shared category.** List what the candidate writes; map it onto what each
   installed mod already writes; keep only intersections where **both sides write the same
   object** (same entity, same rating, same GameModel, same engine action). Two mods in one genre
   that touch disjoint objects are compatible; two that both write clan relations *and* the crime
   rating are not, whatever the genre labels say.
   Report each intersection as a symptom ("AI grudge bookkeeping lags"), never as a verdict
   ("incompatible"), and separate **technical** collisions (Harmony target, model replacement —
   these break a feature) from **balance** interactions (two daily drifts on the same statistic —
   these only produce surprising numbers). Presenting the second kind as the first is the usual
   way this analysis goes wrong.
   Two refinements decide how large an apparent intersection really is, and both are easy to miss
   when both mods are described with the same word ("AI", "crime", "relations"):
   **(a) decide vs. react** — a mod that *decides* (replaces the engine's decision function for
   every faction, on its own schedule) is a potential rival to another decider, but a mod that
   merely *reacts* to the player's own provocation holds no global lever and cannot fight for the
   same steering wheel; **(b) counter vs. consequence** — a mod-owned ledger (its own grudge or
   score field, stored and displayed by that mod) does **not** collide with another mod's rewrite
   of the *vanilla* field, even when the two are marketed as "the same system". If they touch at
   all, they touch one level downstream: the consequences both systems route through the shared
   vanilla field. State which level collides — over-reporting the upstream level is the standard
   error.
   **(c) decide "do they even compete for the same mechanism?" before predicting a winner.**
   Two C# mods in the same subsystem are not automatically a "last one wins" contest, because
   they can be built on two different mechanisms with no shared ordering:
   - **Model registration** — `campaignStarter.AddModel(new X())` in `OnGameStart`, executed in
     launcher order; the last registration of a given model base type wins.
   - **Harmony patching** — order-independent; patches attach to their target method whatever
     the module order is.

   A patcher and a model-replacement **coexist**, and ordering between them is irrelevant: the
   replacement subclasses the vanilla concrete class and opens with `base.<Method>(...)`, so the
   patched vanilla body still runs. Order only ever decides ownership between **two mods that
   both call `AddModel` for the same base type**. The practical corollary: advising the user to
   reorder a Harmony-patching mod against a model-replacing one is advice about nothing — and
   that advice has been given wrongly before, so it must be checked, not assumed.

   **Decide it by scanning the DLLs, cheaply.** An ASCII / `Select-String` pass over each
   module's `bin\**\*.dll` for the tokens `AddModel`, `HarmonyPatch`, and the candidate model
   base-type names (`DefaultArmyManagementCalculationModel`, `DefaultMobilePartyAIModel`,
   `DefaultSettlementGarrisonModel`, `DefaultTargetScoreCalculatingModel`, …) reports, per
   assembly, which mechanism it uses and which model family it touches. Metadata type and member
   names are plain ASCII strings, so `Contains` on the raw bytes suffices — no Cecil needed for
   "does this mod register models at all?". Verified case: an overhaul whose five feature DLLs
   all contained `HarmonyPatch` and **none** contained `AddModel` or any model base-type name is
   a pure patcher, so a model-overriding mod added after it cannot displace it.
5. **Read the author's own docs inside the module folder.** `Modules/<Mod>/README.txt`,
   `Modules/<Mod>/GUI/SpriteParts/*/使用说明.txt`, and packaged notes carry what the download page
   omits: the required load position, "delete these older same-named folders first", the author's
   own inventory of bundled sub-modules, and stated limits. Cheaper and more accurate than the page.

When the author states a load position ("放在列表最下面"), **diff that against the real chain**
in the newest `rgl_log_*.txt` and say whether the install currently complies — mods sitting after
the one that demands to be last is a concrete, actionable finding, and it is invisible from the
launcher UI.

### Satisfy the request with what is already installed, before adding anything

Two cheap channels usually beat a new mod, and both should be checked *before* the recommendation
list is written:

1. **The installed mods' own config.** A mod that deliberately changed a behaviour (AI aggression,
   spawn rates, economy) normally exposes that change as an MCM / MCM-settings toggle or a plain
   `ModuleData/settings.txt`. Re-enabling the vanilla-like behaviour is dependency-free and
   conflict-free, and it is the only option that cannot break anything. Quote the mod's own README
   for the claim.
2. **The engine's own XML, via an override module.** Check the root element and per-entry `id`
   attribute of the vanilla table (`<partyTemplates><MBPartyTemplate id="…">`,
   `spcultures`, `items`) — because objects are keyed by string ID, a tiny module shipping only the
   same-ID object overrides it, so a two-file module can double bandit party sizes with no
   dependencies and no version fragility. Never edit the vanilla file; uninstalling the override is
   lossless, and re-verify by reading the real min/max out of the installed file rather than a guide.
   State plainly which numbers such a module *cannot* change: a party template's `min_value`/
   `max_value` sets party **size** only, while spawn **frequency** lives in a game model — which is
   exactly why spawn-count mods ship C# and require Harmony.

Also classify the request before answering it. "Make the AI smarter" and "give me more enemies"
sound like one ask but land in different layers: *combat/battle* AI (agent & combat models),
*campaign decision* AI (war/peace, policy, kingdom decisions), and *army scheduling* (target
scoring, siege judgment, garrison reinforcement). Mods in the first group collide with combat
overhauls the user already runs; the second group collides with any installed AI-diplomacy
overhaul; the third sits next to but not on top of the second and is where a coexistence test is
worth proposing. Say which layer the answer targets, and name the layer the request does *not*
need.

## Branch: "is there a mod like X that works on my game version?"

A compatibility question, not an authoring one. Do not start the authoring workflow and do
not install anything. The answer has to come from a version matrix, and the only honest
source is the mod's **file list** — not its title or description.

1. Establish the installed version from `<root>/Modules/Native/SubModule.xml` (Step 1).
2. For each candidate, read the Nexus **Files** tab. The `Version` field of the newest file
   (e.g. `e1.4.5.0`) plus its upload date is the real "compiled for" claim. A page title like
   `for e(1.7.X - 1.9.0) v(1.0.X-1.4.5)` restates the union of *all* published files and is
   not a statement about the file you would actually download.
3. Treat third-party "compatible version" tables (aggregator sites, repack download pages) as
   unverified. A repack page claiming `支持1.3.X-1.5.X` while shipping the `e1.4.5.0` file is a
   loose label, not a test result.
4. Content/character-editor mods are C# DLL mods, so they are version-locked in practice. If
   no author in the category has rebuilt for the installed patch, the answer is "not yet" —
   reply with the nearest build plus its risk, the partial alternatives, and the wait. State
   the gap instead of implying an older DLL will work.
5. Before recommending a mismatched build, read the patch notes between the mod's version and
   the installed one. Bug-fix-only patches that do not touch the mod's API surface are where a
   one- or two-patch gap often still loads; a patch that changed the same subsystem is where
   `MissingMethodException` / `MissingFieldException` startup crashes come from. Offer the gap
   as a test with a rollback, never as a working configuration.

### "Something like X" means capability coverage, not category

When the user names a mod and asks for an equivalent, the version matrix alone does not answer
the question. Map the reference mod's **capabilities** one by one onto the candidate and report
the coverage per line, because two mods in the same genre often share almost nothing:

- `Character Reload Fix` (Nexus #3700) is a *character editor*: in-encyclopedia appearance /
  facegen editing, hero renaming, attribute / focus / skill reallocation.
- `Bannerlord Trainer Plus` (Nexus #2278) is a *campaign trainer + bugfix toolbox*: its F10 menu
  covers money, heroes, clans, relations, equipment, settlements and world state. It can max
  skills and grant all perks ("Superman"), rename **clans and kingdoms** — but it has **no**
  appearance/facegen editing and **no** hero renaming.

So a trainer cannot substitute for an editor even when it is compiled for a newer game version.
Say which specific lines of the request are covered and which are not; do not answer "there is
nothing similar" or "yes, this works" at the category level.

### Cost of adoption is part of the answer

Check the candidate's prerequisites against the **installed** module list before advising —
the answer changes materially. The four community libraries (`Harmony → ButterLib →
UIExtenderEx → MCM`) are commonly present, but a mod may additionally require **HotKeys**
(e.g. `Bannerlord.HotKeys` for Trainer Plus 2.2.0+), which is not part of that standard set.
Report "3 of 4 already satisfied, only X missing" rather than "needs four prerequisites".

Also check for **hotkey collisions** with what is installed. Trainer mods bind function keys by
default and do not detect conflicts: Trainer Plus defaults to `F10`, which is the `RTSCamera`
key. A collision is a documented misconfiguration, not a crash — name the rebind.

Flag known-by-the-author side effects too. Trainer Plus is documented (by its own Chinese
localization page) as materially raising the frequency of the vanilla "meat bullet" failure
(character model fails to initialize and folds up), which the author cannot fix.

### Researching a Nexus mod's feature list

The Nexus description tab is Cloudflare-gated and frequently returns an empty shell to a fetch.
Two reliable fallbacks:

- Append `?BH=1` to the mod URL for the description variant, which often returns the real text.
- The Chinese localization repack page on `bbs.mountblade.com.cn` (`download_<id>.html`) carries
  a full translated feature list, the per-file version-to-game-version mapping, the prerequisite
  list, installation path, and the maintainer's own conflict/misconfiguration advice — often
  more useful than the original page. Confirm its `模组原址` link matches the mod you are judging.

### What the installed build already does without any mod

Enumerate the engine's own console commands before recommending a cheat mod — zero
dependencies, cannot break on a version bump.

Command names live in the managed assemblies (`TaleWorlds.CampaignSystem.dll`,
`TaleWorlds.MountAndBlade.dll`). Scan for them, but note the trap: .NET stores a literal
string in **two** heaps depending on usage — the ASCII `#Strings` heap and the UTF-16LE `#US`
heap. A single `raw.decode("utf-16-le", errors="ignore")` over the whole file loses about a
third of the UTF-16 hits, because one odd-length ASCII blob earlier in the file shifts the
parity for everything after it. Decode **both phases** and union:

```python
hits = set()
for phase in (0, 1):
    txt = raw[phase:].decode("utf-16-le", errors="ignore")
    hits |= set(re.findall(r"campaign\.[a-z_0-9]{3,}", txt))
```

Measured on v1.4.8: one phase returned 40 `campaign.*` commands, both phases 68. A single
ASCII-byte search is a different check and can hit one heap while missing the other — verify
both encodings separately when a command's existence decides the recommendation.

Also verify the *absence* of commands older guides still recommend:
`campaign.reset_player_skills_level_and_perks`, cited by many community respec walkthroughs,
is gone by v1.4.8.

Native fallbacks worth naming (present in v1.4.x): perk reassignment for the player and
companions through the arena master for a fee (added in e1.8.0), and the `_to_hero` cheats
(`add_gold_to_hero`, `add_attribute_points_to_hero`, `add_focus_points_to_hero`,
`add_skill_xp_to_hero`) plus `set_skills_of_hero`, `set_all_heroes_skills`, `export_hero`,
`import_main_hero`. Opening the console still requires a console-capable loader or a console
mod — do not assume the vanilla build exposes it.

## Branch: "does mod X need a 汉化 / will I see English in game?"

This is a **string-surface** question, not a translation-availability question. Answer it by
enumerating what the mod can put in front of the player, before searching for whether a
translation exists. Three answers are possible and they are not interchangeable:
"a 汉化 exists", "there is nothing to translate", and — the common case for a campaign-logic
mod — **"there are a handful of keys and no pack ships them"**, which is a do-it-yourself job
of two small XML files rather than a search for a download.

Do not stop at the mod's dependency list. "No MCM, no UIExtenderEx" rules out a *settings
panel*; it does **not** rule out text, because a model-override mod injects strings through
vanilla explanation parameters without touching the UI stack at all.

Mechanical evidence, in order of strength:

1. **The published Requirements list tells you whether there is a settings panel — and nothing
   more.** MCM is the in-game options screen library, and MCM itself requires Harmony +
   ButterLib + UIExtenderEx. So a mod whose requirements are `Native, SandBoxCore, Sandbox`
   plus a note like **"No Harmony required"** cannot be registering an MCM panel, and one that
   also omits UIExtenderEx has no plausible Gauntlet surface. Read that as "its settings are
   read from a file, so no English settings labels in game" — **not** as "it shows no text",
   which is a different claim that step 4 has to settle.
2. **Locate the settings channel.** `ModuleData/settings.txt` (or any plain `.txt/.json/.xml`
   the author says to edit) is a text file in the module folder — English appears there, in
   Notepad, outside the game. Contrast the War-and-AI-Tweaks case, where users posted
   "进游戏怎么没有mod设置呀" precisely because that mod *did* route settings through an MCM
   panel with English labels.
3. **Log-only outputs are not a translation surface.** `Documents\Mount and Blade II
   Bannerlord\<Mod>.log` (the usual `VerboseLogging` destination) is diagnostic text written
   outside the game.
4. **Search for `{=KEY}` literals before concluding "nothing to translate".** This is the step
   that is easiest to skip and easiest to get wrong. A C# mod can route text through the game's
   localization system with `new TextObject("{=KEY}English default")`, and then it **is**
   translatable — by a language pack — even with zero UI dependencies. Do not reason
   "no MCM / no UIExtenderEx ⇒ no UI ⇒ nothing to translate"; the localization system is
   orthogonal to the UI stack, and a pure *model-override* mod still injects text through the
   vanilla APIs that exist for displaying explanations:
   - `ArmyManagementCalculationModel.CheckPartyEligibility(party, out TextObject explanation)` —
     the `out TextObject` contract exists so the UI can show why a party cannot join an army.
     Confirmed UI-consumed: `TaleWorlds.CampaignSystem.ViewModelCollection.dll` references
     `CheckPartyEligibility`, not only `TaleWorlds.CampaignSystem.dll`.
   - `CalculateDailyCohesionChange(army, includeDescriptions)` — with `includeDescriptions: true`
     the mod's `TextObject` becomes a line in the army tooltip.
   Scan the mod's shipped sources (`src/**/*.cs`) when present — an author who ships source
   saves you the whole decompile — otherwise scan the DLL's **UTF-16** string heap for `{=`.
   Only when neither yields a hit may you answer "no translation surface"; and even then the
   honest phrasing is "no strings reach the screen", not "a 汉化 cannot exist".

   **Deliverable recipe when keys do exist** (verified against working translations already
   installed on this machine — `MutliLittleFixes`, `Warbandlord`, `BannerlordSage` all keep the
   pack *inside the mod's own folder*): two files under
   `<mod>\ModuleData\Languages\CNs\`, using the encoding of that mod's own existing language
   files (see the encoding rule below):
   - `language_data.xml`
     `<LanguageData id="简体中文" name="简体中文" subtitle_extension="zh-HANS" supported_iso="zh-HANS,zh,zho,chi,zh-cn,zh-sg" under_development="false"><LanguageFile xml_path="CNs/<name>.xml"/></LanguageData>`
     (a `Languages\language_data.xml` at the module root declares the *default* language set and
     is **not** needed when the English defaults are already compiled into the DLL)
   - `<name>.xml` (convention: `std_<Assembly>-zho-CN.xml`)
     `<base xmlns="http://schemas.taleworlds.com/2007/04/GameSystem/" type="string"><tags><tag language="简体中文"/></tags><strings><string id="KEY" text="译文"/></strings></base>`
   **Encoding: imitate the target module's own language files, do not impose one.** All three
   encodings load on v1.4.8, measured on one machine:
   | module | file | bytes |
   |---|---|---|
   | `Native` | `CNs/language_data.xml` | **UTF-16 LE + BOM** |
   | `Warbandlord` | `CNs/simplified_chinese_module_string.xml` | UTF-16 LE + BOM |
   | `MutliLittleFixes` | `CNs/std_module_strings_zho-CN.xml` | UTF-8 + BOM |
   | `Bannerlord.MBOptionScreen` (BUTR's own pack) | `CNs/sta_strings.xml` | **UTF-8, no BOM** |
   | `BannerlordSage`, `SiegeAIFix` | `…/*.xml` | UTF-8, no BOM |
   So "UTF-8 without a BOM is silently ignored" is **false** — BUTR ships its own Chinese pack
   with no BOM and it works. Read the first 3 bytes of the module's shipped `EN`/`KO` file and
   reproduce exactly that. When *editing* an existing pack, preserve its BOM state (write bytes
   back unmodified outside the inserted lines) rather than re-encoding the whole file. Note the
   directory is inside a **Vortex-managed** module folder, so a later Vortex purge/redeploy may
   remove it: keep a copy of the two files outside the game directory and say so.

   Then answer in this shape: state whether a translation is needed **and how many strings are
   actually involved** — "需要汉化，但只有 3 条" and "需要汉化，且是整屏设置项" are very different
   answers to the same question — name where they surface, and hand over the files rather than
   telling the user to go find a 汉化包.

Never enumerate a settings file's contents from memory — read the installed file. If the
mod is not installed, say the annotated copy must wait for installation rather than inventing
five hundred plausible setting names.

### Technique — "汉化 my mod menu": build a key-coverage table, do not guess per mod

"Which of my mod-option pages are English" has a mechanical answer. The MCM page for mod X
shows exactly the `{=KEY}` strings that X (or MCM on X's behalf) resolves, so the question is
which of those keys some installed language pack defines for 简体中文:

1. **Read the version-matched MCM assembly, not a mod's DLL, when the strings are MCM's own.**
   The installed module is `Bannerlord.MBOptionScreen` (id of MCM v5); inside it
   `Bannerlord.MBOptionScreen.v<gamever>.dll` is the version-specific assembly actually loaded
   on that game version (`v1.4.8.dll` here), alongside `MCMv5.dll` and
   `MCM.UI.Adapter.MCMv5.dll`. Extract the keys from it — see
   **"Extract whole literals, never substring-match"** below; the phase-shift trick
   (`raw[phase:].decode("utf-16-le")`) is superseded by a run-based scan. Whole-literal
   extraction on `v1.4.8` yields **51 keyed literals**; across `Bannerlord.ButterLib.v1.4.8`'s two
   assemblies plus MCM's, the ButterLib page needs **75 distinct keys** (51 + 12 + 18 − 6 shared).
2. **Enumerate every installed pack** for the locale: for each module, the `id=` of every
   `ModuleData\Languages\*\language_data.xml` (the id must read `简体中文`; `BannerlordConfig.txt`
   in `Documents\…\Configs\` carries `Language=简体中文` and confirms which id is live), and the
   `<string id>` sets of the files it declares. Language files are loaded **globally from every
   module**, so a key may be supplied by a pack that lives in a different module than the mod
   that uses it — that is the trap this technique exists to avoid.
3. **Diff** → keys covered by no pack. Those are the only real candidates for "English on
   screen", and the honest deliverable is a count plus the files.

Two ownership facts that make the naive reading wrong, both verified on v1.4.8:

- **`ButterLibSettings_*` lives in `Bannerlord.MBOptionScreen.v<ver>.dll`, and its translations
  live in MCM's own `ModuleData\Languages\CNs\sta_strings.xml` — not in ButterLib's folder.**
  ButterLib's DLLs contain no `ButterLibSettings` literal at all. What ButterLib's *own* packs do
  carry are the second set of pages (crash handler, distance matrix, hot keys, save system,
  delayed SubModule …) under random-looking 10-char keys (`Ox6uK8fZWs` = 距离矩阵,
  `66A5N9278w` = 保存系统).
- **BUTR's own CNs packs lag their EN packs by exactly two keys**, in both `Bannerlord.ButterLib`
  (`MSJe8ih4yp` / `kvR54SiOFn`) and `Bannerlord.MBOptionScreen` (`HOV8WIcBrb` / `2d99VmOZZH`).
  `len(EN ids) - len(CNs ids)` is the cheapest possible audit — two lines fix it.

Cheap confirmations, in preference order:

- **`Documents\Mount and Blade II Bannerlord\Configs\ModSettings\<ModuleId>\<Page>.json`** exists
  for every MCM page the game has actually instantiated (`ButterLib\Options.json`,
  `Global\MutliLittleFixes\MutliLittleFixes_v1.json`). No folder for a mod ⇒ no MCM page, which
  settles "does mod X even have a mod menu?" from the filesystem.
- A module whose DLL contains none of `AttributeGlobalSettings` / `SettingPropertyBool` /
  `SettingPropertyDropdown` / `SettingPropertyGroup` registers no MCM page. (Scan both ASCII and
  UTF-16 — these are metadata names, so ASCII is normally enough.)
- What a CNs pack can never fix: **enum values rendered by name** (a `LogEventLevel` dropdown
  still reads `Information`), and strings the mod writes straight to a **debug/chat log**
  (`[Debug - SiegeAIFix] Army '{0}' has too many wounded…`). Tell the user these are not
  language-pack territory instead of silently leaving them out.
- Never use "count the CJK codepoints in the DLL" as evidence of hardcoded Chinese (or of
  anything else). Decoding a mixed binary as UTF-16 LE yields thousands of fake CJK runs out of
  ordinary metadata bytes — 5 326 of them in a 190 KB assembly. Gate on the module shipping a
  `Languages\CNs\` folder instead.

### Technique — extract whole literals, never substring-match

A `{=KEY}` regex over the raw bytes produces **substring** hits: `{=Ox6uK8fZWs}Distance Matrix`
contains `Distance Matrix`, so a hit proves nothing about whether the bare `Distance Matrix` also
exists. Search whole literals instead — a `{=KEY}` marker is consumed by the resolver when a
translation exists, so a *bare* literal is the thing that can never be translated:

```python
RUN = re.compile(rb"(?:[\x20-\x7e]\x00){4,}")          # whole UTF-16LE printable run, any phase
KEY = re.compile(r"\{\=[A-Za-z0-9_]+\}")                # marker present => localizable candidate
for m in RUN.finditer(open(dll, "rb").read()):
    s = m.group(0).decode("utf-16-le", "ignore")
    print("LOCALIZABLE" if KEY.search(s) else "HARD-CODED ", repr(s))
```

Run-based scanning is **phase-free** (it finds UTF-16 runs starting at either byte offset), so it
replaces the old "decode twice with a 1-byte shift" trick, and it returns the literal verbatim —
which is what you need to tell `{=MSJe8ih4yp}Consider Villages` from a hardcoded `Consider Villages`.

### The three classes of English on a BUTR mod-options page

When a user shows a screenshot of an MCM page that is English despite a complete Chinese pack,
every visible string falls into exactly one class. Classify before promising a fix — only class 2
has any hope, and even then usually none.

| Class | How to recognise | Fixable by language files? |
|---|---|---|
| 1. Framework plumbing literals | bare C# literals that carry no `{=KEY}` at all. On the ButterLib page: the group titles are `"SubSystem "` (a literal in `Bannerlord.MBOptionScreen.v<ver>.dll`) **concatenated with the subsystem's `Id`**, and every `Id` is bare — `"CrashUploader"`, `"Distance Matrix"`, `"ExceptionHandler"`, `"Hot Keys"`, `"MBSubModuleBase extended"` in `Bannerlord.ButterLib*.dll`. The `Enabled` toggle label is the bare literal `" Enabled"` (leading space), present in *both* assemblies. | **No.** No key exists to translate. Needs a DLL patch. |
| 2. Keyed strings that render their default text | the literal *does* start with `{=KEY}` and the installed pack *does* define `KEY` — yet English shows. Proven on `{=MSJe8ih4yp}Consider Villages` ("计入村庄") and `{=B7bfrDNzIk} Disable when Debugger is Attached` ("调试启动时禁用") — both 30/30 covered, engine-opened, error-free, still English. | **No, in practice.** See the `Options.json` tell below. |
| 3. Genuinely missing keys | in the page owner's assemblies but in no pack. On v1.4.8: 14 of MCM's 75 — the value-format placeholders (`2Tp85Cpa`, `7tpjjYSV`, `Es0LPYu1`, `fgLroxa7`, `yBflFuRG`, `CarGIPlL`, `T3FtC5hh`) plus `WiNRdfsm` (Done), `3CpNUnVl` (Cancel), `5Unqsx3N` (Confirm), `aeouhelq` (Yes), `8OkPHu4f` (No), `HNduGf7H5a`, `JLKaTyJcyu`. The placeholders are invisible; the button words may show English on MCM dialogs. | **Yes** — this is the only class worth writing. |

**The `Options.json` tell.** `Documents\Mount and Blade II Bannerlord\Configs\ModSettings\
<ModuleId>\<Page>.json` lists every setting this page exposes, keyed by MCM's internal name. For
the ButterLib page the keys are the **marker-stripped English text** —
`"Distance Matrix Enabled"`, `"Hot Keys Enabled"`, `"Save System Enabled"`, `"CrashUploader
Enabled"`, `"ExceptionHandler Enabled"`, `"MBSubModuleBase extended Enabled"` — plus
`"<SubSystemType>_<PropertyName>"` (`"DistanceMatrixSubSystem_ConsiderVillages"`,
`"ExceptionHandlerSubSystem_DisableWhenDebuggerIsAttached"`). No CJK ever appears there even on a
Chinese install. That is the mechanical proof that ButterLib's `SubSystem` settings API resolves
its `TextObject` names to plain text **before** handing the model to MCM, so class 2 is a framework
defect, not a translation gap. Supporting timing hint: the ButterLib implementation assembly loads
(~19:39:05.75) *before* the language tables (~19:39:09.2), so a `TextObject.ToString()` evaluated
at registration time caches the English default.

**How to answer the user.** Give the class table with the count per class and say plainly which
ones a 汉化 can never touch, then correct any earlier over-broad claim ("ButterLib's menu is
already Chinese" is false as stated — the truth is "its keyed strings are all translated, but the
page's visible English is mostly framework plumbing"). Offering a Harmony patch is honest only
with its costs: re-write per BUTR release, and rewriting `Id` can invalidate existing saved
settings. A cheap self-check to hand over: scroll to the page's **Logging** group — if
`日志记录中` / `日志等级` show in Chinese, the localization channel is healthy and the English is
hardcoded; if they are English too, the label channel is broken — the verdict (language files
cannot fix it) is the same either way.

## Workflow

### Step 1 — Locate the install and establish the version

Run `scripts/probe_game.py`. It walks drive letters for `steamapps` directories, parses
every `libraryfolders.vdf` to find non-default library drives, locates the Bannerlord
directory, and prints the detected module list plus file layout. (It deliberately avoids
the registry — see the environment caveat at the end of this file.)

```bash
python scripts/probe_game.py            # auto-detect
python scripts/probe_game.py --root "G:\\...\\Mount & Blade II Bannerlord"
```

Definitive version source: `<root>/Modules/Native/SubModule.xml`, the `<Version>` tag. Note
the tag may be written `<Version value = "v1.4.8"/>` with spaces around `=`, so a regex
requiring exactly one space silently returns nothing. Do not infer the version from the
executable's `FileVersion` — `Bannerlord.exe` always reports `1.0.0.0`.

Treat the probe output as ground truth for the rest of the task. Three facts it establishes
that change the whole plan:

- **Is the Modding Kit installed?** (`bin/Win64_Shipping_wEditor`). Without it there is no
  Scene Editor and no asset pipeline — custom scenes, models, meshes, and materials are off
  the table, and XML-only approaches are the only option.
- **Which loader and dependency stack is present?** (`Bannerlord.BLSE.Launcher.exe`,
  `Bannerlord.Harmony`, `Bannerlord.ButterLib`, `Bannerlord.MBOptionScreen`,
  `Bannerlord.UIExtenderEx`). If the mod will need C# patching, these determine what can be
  depended on.
- **Which data tables actually exist on this version.** Read the real file list before
  designing anything.

### Step 2 — Read the real schema

Read the actual files, not a remembered schema. Read `references/module-layout-and-schema.md`
first for the table map and encoding rules, then open the specific source files.

Minimum reads before writing anything:

1. `<root>/Modules/<OfficialModule>/SubModule.xml` — copy the `<Xmls><XmlNode><XmlName>`
   declaration shape verbatim, including the `IncludedGameTypes` block.
2. The `<root>/Modules/<OfficialModule>/ModuleData/<table>.xml` file you intend to override —
   enough lines to see one complete top-level element.
3. The localization layout under `ModuleData/Languages/<locale>/` if the mod adds text.

Useful probe: read a real element that resembles your target (e.g. to add a troop, read an
existing troop of the same culture and tier) rather than starting from a blank file. The
vanilla data also reveals valid item ID combinations directly, which beats guessing.

### Step 3 — Choose the mechanism

| Goal | Mechanism | Notes |
|---|---|---|
| Change values, add entities | XML override in your module's own file | Preferred. Additive, reversible. |
| Add a new entity of an existing type | New element with a fresh ID | Coexists with vanilla entries. |
| Change campaign/economy/party parameters | Parameter tables (`managed_campaign_parameters.xml`, `native_parameters.xml`) | Pure data. |
| New behaviour, events, AI, UI logic | C# `SubModule` class + Harmony patches | Requires referencing `TaleWorlds.*.dll`; version-fragile. |
| New scenes / models / materials | Official Modding Kit | Unavailable without the editor binaries. |

**The load semantics that make small modules possible:** the object manager registers objects
under string IDs, and objects from later-loading modules override same-ID objects from
earlier ones while distinct IDs coexist. A patch module therefore ships only the objects it
adds or overrides — it must never copy an entire vanilla table, and copying one to "be safe"
is a bug, not caution.

**Prefer overrides that are additive.** Adding an upgrade branch, a new troop, or an extra
item keeps every vanilla element intact and makes uninstalling lossless. When the only
available hook is a single-valued culture field (recruitment roots), say so explicitly and
present the destructive trade-off instead of silently taking it.

### Step 4 — Generate with exact encodings

Encoding mismatches are a top cause of "the game ignores my module". Copy the conventions
observed in the installed official modules:

- `SubModule.xml` and data-table XML: **UTF-8 with BOM**, declaring `encoding="utf-8"`.
- Localization files under `Languages/<locale>/`: **UTF-16 LE with BOM**, declaring
  `encoding="utf-16"`.

Use `scripts/scaffold_module.py` as a starting point — it writes files with these encodings
and can extract a vanilla element verbatim for override injection.

**Extract, never transcribe.** When overriding an existing element, pull the byte-exact
source block out of the game file and modify only the part being changed. Hand-copying a
100-line element is how typos enter item IDs.

### Step 5 — Validate statically, before launch

Run `scripts/validate_refs.py` against the generated module. It parses the module's XML
files, collects every `Item.*`, `NPCCharacter.*`, `BodyProperty.*`, `EquipmentSet`, and
skill reference, and checks each against the installed game data, plus XML well-formedness
and upgrade-chain closure.

```bash
python scripts/validate_refs.py --module ./HouseholdGuards --root "<game root>"
```

Do not report a mod as done on a passing XML parse alone. A well-formed file with a typo in
an item ID loads and then fails at runtime. The ID cross-check is the load-bearing check.

Also verify by hand what static validation cannot see:

- **Subtle reference forms** — some references use `value=` rather than `id=`. A regex
  written for one silently matches nothing for the other, producing a green check that
  tested nothing. Confirm each check actually collected a non-empty set; an empty set is a
  failed check, not a pass.
- **Single-valued vanilla fields** (e.g. a culture's `basic_troop`) and whether overriding
  them removes content.
- **Vanilla cardinality limits** (e.g. troops normally carry at most two `upgrade_target`
  entries). Exceeding the data cardinality is usually legal but may not render; flag it as
  unverified rather than claiming it works.

### Step 6 — Report honestly

State separately: what was statically verified, what was not, and what remains uncertain.
If the game could not be launched to test, say so plainly and give the fallback design for
any part that depends on unverified behaviour. Never present a statically-validated mod as
a working one.

### Re-indexing the BannerlordSage index when it goes stale

The MCP's index DB is `dist/games/bannerlord/bannerlord.db`; the runtime-revision stamp
is the plain-text ISO timestamp in `dist/games/bannerlord/Version.txt` (written by
`writeRuntimeRevision(gameId, new Date().toISOString())`). The granular rebuild commands
live in `package.json` as `bun run src/scripts/index-<target>.ts` where `<target>` is one
of `csharp`, `xml`, `bannerlord-gameplay`, `docs`, `api-docs`. **Gotcha: the script is
`index-bannerlord-gameplay.ts`, not `index-gameplay.ts` — the latter does not exist and
errors with "Module not found".** The `index-mod-source.ts` target requires
`BANNERSAGE_MOD_SOURCE_DIR` (or `--source-dir`); with no mod workspace configured it
refuses.

The index scripts are **incremental**: each compares source DLL MD5/size and XML mtime
against `dist/games/bannerlord/setup-state.json` and skips unchanged files. So a re-run
on an unchanged game (same version) is a near-instant no-op for C#/XML/gameplay but still
re-fetches docs/API from the network and may grow those counts. Two important behaviors:

- The per-script `index-*.ts` commands do **not** bump `Version.txt`. Only the full
  `setup` writes it. After a manual re-index, write the current UTC ISO timestamp
  (`2026-09-27T10:20:47.446Z` shape — 3-digit ms + `Z`) into `Version.txt` to make the
  MCP's `bannerlord_index_status` report the refreshed revision. (PowerShell `%`-format
  strings are blocked by the sandbox; use Python
  `datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.")+f"{…microsecond//1000:03d}Z"`.)
- WAL mode is on (`bannerlord.db-wal` present), so the re-index can run while the MCP
  server holds the DB open; readers coexist.

Run them from the repo root with the same env the MCP server uses
(`BANNERSAGE_GAME=bannerlord`, `BANNERSAGE_BANNERLORD_GAME_DIR=…`,
`BANNERSAGE_ILSPYCMD_EXE=…`, `BANNERSAGE_EULA_ACCEPTED=true`).

## Reusable resources

- `scripts/probe_game.py` — locate install, resolve all library drives, print version,
  module list, data-table inventory, localization layout, Modding Kit presence.
- `scripts/scaffold_module.py` — write a module with correct encodings; verbatim element
  extraction for override injection. **Two recorded defects — hand-correct them in its
  `SubModule.xml` output** (kept unfixed so the script stays diffable against upstream):
  (1) it hard-codes `<DependedModule Id="SandBox" />` with a **capital B**, while the official
  declaration and this skill's own `list_load_order.py` both use `Sandbox`; (2) its
  `KNOWN_TABLES` maps `PartyTemplates → spnpccharactertemplates`, but that file's official
  `id` is `NPCCharacters` (and the party-template table's official id is `partyTemplates`,
  lowercase p). `validate_refs.py` does **not** check dependency-id validity, so it reports
  **PASS** on defect 1 — a passing validation is not evidence that the scaffold is correct.
- `scripts/validate_refs.py` — cross-table ID validation and XML well-formedness report.
- `scripts/diagnose_crash.py` — read-only triage of an existing install: per-session
  load-chain/crash table from `rgl_log_*.txt`, crash-code translation, "module present in
  every crash and no clean run" correlation, `LauncherData.xml` vs actually-loaded diff,
  and modules whose folder has no manifest.
- `scripts/list_load_order.py` — read-only inventory + load-order planner: every module's
  id/version/type/dependencies/XML tables, a dependency-correct recommended order, the
  diff against the launcher's stored order, risk findings (missing deps, bundled-DLL
  collisions, never-loaded modules, data-table override conflicts), and the session
  history. `--format md|json|both`, `--out-dir`, auto-detects root/launcher data/logs.
- `references/module-layout-and-schema.md` — directory conventions, encoding rules, the
  data-table map, common element schemas, localization mechanics, load-order semantics
  (including the **XSLT field-level override channel**), and the localization key format.
- `references/submodule-xml-reference.md` — the field-level `SubModule.xml` dictionary: every
  metadata element with official-module statistics, **`RequiredBaseVersion`** (the real
  compatibility field — `<Version>` is *not*, official `NavalDLC` writes `v1.2.8` alongside
  `v1.4.8`), `ModulesToLoadAfterThis` / `IncompatibleModules`, `<Xmls>` table-registration
  semantics (an undeclared table is never loaded), per-file encodings with byte evidence,
  the pure-file module layout, and a pre-delivery checklist.
- `references/csharp.md` — the C# route: which assembly holds which type, the `MBSubModuleBase`
  template and lifecycle table, Harmony patch templates plus the model-replacement
  blast-radius rule, `MBObjectManager` runtime field edits, why `PerkObject` is code-only,
  the compile constraints on this machine, and the reflection probes that silently return
  wrong answers.
- `references/programmatic-battle-start.md` — starting a battle from code (`MissionState.OpenNew`)
  with no player: the **two-path rule** that decides whether you must call
  `Mission.OnDeploymentFinished()` or `Mission.OnInitialSpawnCompleted(BattleSide)` (get this wrong
  and the mission opens but never runs — `CurrentTime` pinned at ~0), `MissionAgentSpawnLogic`'s
  `IsInitialSpawnOver`/`IsDeploymentOver` as the one-run diagnostic, why a missing notification also
  silently disables third-party patches on those callbacks, the correct behavior-injection hooks
  and the `OnGameStart` anti-pattern, **scene × scene-level data completeness** as a hard limit,
  and the reference implementations (EnhancedBattleTest, Virtual BattleGrounds, RBM, Auto Battle
  Overhaul) plus how to get a method-level stack without `cdb.exe`.
- `references/butr-stack-and-localization.md` — BUTR provenance, why upstream Chinese packs
  must never be edited in place (Weblate-managed), the five-check pre-flight gate that must
  pass *before* judging whether any visible English is translatable, and the `Id`/`Name`
  asymmetry on mod-options pages.
- `references/diagnosing-mod-conflicts.md` — the triage procedure in full: log locations,
  honest session classification, crash-code table, Vortex symlink pitfall, version-matrix
  reasoning, the list of log lines that look alarming but are benign, and the **tool traps
  that silently produce wrong conclusions** (an empty check is a failed check, not a pass) —
  including §8.1 on why an **incomplete decompiled-source tree** must never be trusted for a
  "this API has zero callers" claim, and the one-line `grep -r -a --include='*.dll'` over the
  shipped assemblies that settles it.
- `references/load-order-and-mod-inventory.md` — the real load-order model (library tiers
  precede Native), why the engine's own chain beats every config file, the
  `LauncherData.xml` schema, official-optional vs community classification, the
  `SandBox`/`Sandbox` id-casing trap, **which level of a Vortex deployment is actually
  linked** (the files, not the folder), and the mtime technique for finding mods that were
  installed but never ran.

## Notes on scope

XML-only mods (troops, items, cultures, parameters, localization) are reliable to author and
validate from the filesystem alone. C# mods can be written but their API surface is
closed-source — obtain signatures by decompiling the shipped `TaleWorlds.*.dll` files or
reading open-source mods, and expect per-version breakage. Scene and asset work requires the
Modding Kit and cannot be produced from the command line.

## Environment caveat

On Windows, the bundled Bash shim may lack coreutils (`dirname`, `head`, `tail` all fail),
and `rm` may be remapped to a broken safe-delete. Use the PowerShell tool for filesystem
work, and invoke Python by absolute path (e.g.
`C:\Users\<user>\.workbuddy\binaries\python\versions\<ver>\python.exe`). PowerShell stdout
has also been observed to be swallowed in some sessions — if a command returns no output,
redirect to a file and read the file instead of assuming the command failed.

**Write `.ps1` helper scripts to an ASCII-only path.** A script saved under a workspace
subfolder whose name contains Chinese characters (`…\诊断-过程文件\x.ps1`) exits with code 1
and produces *no* output at all — no error text, no partial dump — which reads exactly like
"the script logic is wrong". Keep scripts and their output files at an ASCII path (e.g.
`<workspace>\_probe.ps1`) and move them into the Chinese-named folder afterwards.

**`LauncherData.xml` is under `Documents`, not `ProgramData`.** The real path is
`%USERPROFILE%\Documents\Mount and Blade II Bannerlord\Configs\LauncherData.xml`.
`C:\ProgramData\Mount and Blade II Bannerlord\` contains only `logs\` and `Shaders\` — a
`Test-Path` on a `ProgramData\LauncherData.xml` returns `False` and looks like "the launcher
has no stored order", which is wrong.

**PowerShell reports `Length` as 0 for Vortex-symlinked files.** `Get-ChildItem -Recurse -File`
lists every DLL, GGUF and XML of a Vortex-deployed module as `0KB` with identical timestamps,
while the module loads and runs fine. This is the same root cause as the `find -type f` trap —
listed size is not evidence of a broken deployment. Read the module's own `log\*.log` mtimes
(today's timestamps = it ran) instead of size when judging whether a module is live.

**The Grep tool cannot see inside a Vortex-deployed module, but Read can.** ripgrep does not
follow symlinks, so a search over `Modules\<Mod>\src` or `Modules\<Mod>\ModuleData` returns
"No matches found" even though every file is present and readable — a false negative that
reads exactly like "the file is empty" or "the symbol is absent". Use `Select-String` through
the PowerShell tool (which resolves symlinks) for content scans inside those folders, and the
Read tool for whole files (Read also resolves them). Never conclude "the string is not in this
mod" from a Grep miss under `Modules\`.

**PowerShell `Remove-Item` can silently no-op on workspace files.** `Remove-Item <paths> -Force`
has been observed to return exit code 0 while leaving every file in place, with no error text —
so a "cleanup done" step can be fiction. Always verify the deletion (re-list, don't trust the
exit code), and when it did not take, delete with Python instead:
`python -c "import os; os.remove(r'<path>')"` works and surfaces the real exception if it fails.
The same applies to `Move-Item`/`Copy-Item` results — confirm the destination.

**Check for a shipped `src\` folder before reaching for Cecil.** Mods distributed with their C#
sources (`Modules\<Mod>\src\**\*.cs`) let you read registrations and literals directly —
`SubModule.cs` for `AddModel`/`AddBehavior` calls, the model classes for their base types,
and `{=KEY}` literals for the localization surface. This is faster and more trustworthy than
metadata spelunking, and it was the decisive artefact in the Strategic Campaign AI case.
The `__folder_managed_by_vortex` marker file contains only a human-readable note ("This
directory was created by Vortex deployment and will be removed during purging if it's empty")
— it does **not** record the staging path, so it cannot be used to find the Vortex mod folder.

**You cannot compile a C# mod in this sandbox, and you cannot even trigger a user-side build script.**
All three routes are closed off (all observed, not assumed):
- `csc.exe` → `Command blocked for security: csc.exe compiles arbitrary C# code (equivalent to Add-Type)`
- `PowerShell` `Add-Type -TypeDefinition … -OutputAssembly out.dll -OutputType Library` → `Command blocked for security: Add-Type compiles and loads .NET code at runtime`
- `ilasm.exe` → `Command blocked for security: Known LOLBin executable that can run arbitrary code`
- `cmd.exe` → `cmd.exe cannot be used from the PowerShell tool` (a hard tool rule, *not* overridable by
  `dangerouslyDisableSandbox`), so a `build.bat` can never be launched by the agent.

Do not try to reach the compiler through another host process, a Roslyn assembly loaded with
`Add-Type -Path`, or a Cecil-based IL emitter — that is evading the control, not satisfying it. There is
`dotnet.exe` with **no SDK** and no Visual Studio, so `dotnet build` / `msbuild` are unavailable too.
The build step is inherently the user's.

Deliver `.cs` + `SubModule.xml` + a `build.bat` that invokes
`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` with `/r:` pointing at the game's own
`bin/Win64_Shipping_Client/TaleWorlds.*.dll` (plus `0Harmony.dll` from `Modules\Bannerlord.Harmony\` and
`%WINDIR%\…\System.dll` / `System.Core.dll`), `/target:library /platform:x64`, and have it write straight
into `module\bin\Win64_Shipping_Client\` so the folder is install-ready. Keep the C# to C# 5 syntax — that
compiler is C# 5 (no interpolation, expression-bodied members, `?.`, `nameof`, `out var`) — and note that
a 4.0-targeted assembly loads fine on the game's 4.7.2 runtime.

Since you get no compiler feedback, pre-verify the source against the real assemblies before shipping it:
for every API you call, confirm existence **and accessibility** with Cecil (e.g. `Harmony.Patch(MethodBase,
HarmonyMethod, HarmonyMethod, HarmonyMethod, HarmonyMethod)`, `HarmonyMethod(MethodInfo)`,
`MBSubModuleBase.OnSubModuleLoad`/`OnGameStart` are `protected internal virtual` ⇒ cross-assembly
override must be declared `protected`), and check for type-name ambiguity across the namespaces you
`using` (a second `Game` would make `Game` ambiguous — here `Game`/`IGameStarter` exist only in
`TaleWorlds.Core`). Also brace/paren-balance the file, and prefer reflection-by-name over a
compile-time reference to the mod you are repairing so a missing/changed mod degrades instead of
crashing.

**Never shell out to `reg.exe`.** It is on the sandbox program blacklist, and a blacklist
hit kills the entire process with a non-catchable error rather than raising inside the
subprocess call. Discover installations by filesystem inspection instead — walk drive
letters for `steamapps` directories and parse `libraryfolders.vdf` for non-default library
drives. `scripts/probe_game.py` is written this way; keep it that way when extending it.

Also watch for substring-collision bugs in the extraction regexes themselves, since they
fail silently in the same direction as a wrong ID check: `<upgrade_target` also matches the
`<upgrade_targets>` wrapper element, which inflates every cardinality count by one. Require
a following delimiter (`<upgrade_target\s`) rather than a bare prefix.
