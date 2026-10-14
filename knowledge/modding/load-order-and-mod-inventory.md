# Load order and module inventory

Everything here was verified against a real 1.4.8 install with 19 modules, 6 of them
community mods. It exists because the obvious assumptions are wrong in ways that produce
confidently incorrect reports.

## The load-order model

The single most common mistake is assuming `Native` loads first. It does not. The four
community base libraries precede it, and that is correct, not a misconfiguration:

```
Bannerlord.Harmony
Bannerlord.ButterLib
Bannerlord.UIExtenderEx
Bannerlord.MBOptionScreen      (MCM v5)
Native
SandBoxCore
Sandbox
CustomBattle
StoryMode
NavalDLC
BirthAndDeath / FastMode       (official optional)
... community mods
```

Do not "fix" this ordering. A checker built on an "engine first" model will flag a
correct install as broken.

Within the community tier, order is only strictly forced by declared dependencies.
Beyond that, prefer keeping the launcher's existing arrangement: it is the arrangement
the engine has actually been running, and reshuffling mutually independent mods is churn
that can only add risk. The one rule worth enforcing is **mods that override core data
tables go last**, because objects are registered by string ID and later modules override
earlier ones.

### The engine enforces dependencies for you

Declared `DependedModules` are honoured by the engine regardless of the order shown in
the launcher or in Vortex. Observed directly: Vortex's `*_loadorder.json` listed
`Harmony, UIExtenderEx, ButterLib, MCM`, but the engine's own `Command Args` chain came
out `Harmony, ButterLib, UIExtenderEx, MCM`. Consequence for advice-giving: **changing
the displayed order can never fix a missing dependency**, and only genuinely
unconstrained modules can be repositioned at all. Say that plainly instead of implying a
sort is a repair.

## Validating a "data table conflict" before advising on order

A shared table *name* is not a conflict. Objects register under string IDs and only same-ID
entries collide, so the honest check is at ID level:

- **Read `SubModule.xml` `<Xmls>` and ignore commented-out blocks.** A naive regex over the
  file counts `<XmlNode>` sitting inside `<!-- … -->` as a live registration. Observed: a
  module reported as writing both `Monsters` and `GameText` in fact registered **only**
  `GameText` — its `Monsters` block was commented out, which made the `monsters.xml` left
  in `ModuleData/` an inert file. That alone removed a phantom conflict with another mod.
- **Compare the actual key sets.** Extract `id="…"` from each mod's GameText files and
  intersect them. Observed: two mods both registering `GameText` had **0** shared keys
  (`cr_*` / `CharacterCreation_*` vs `RTSCamera_*` / `str_key_*`), so their relative order
  was free despite a "conflict" line in the inventory. Two RTSCamera-family modules did
  share 32 keys, but those were a vendored `MissionLibrary` shipped in both.
- **`modified_x.xslt` transforms the loaded table; `x.xml` replaces entries in it.** A mod
  using XSLT is not writing a full table override, and the two only interact when both
  register the same table id.
- **`DependedModules` alone does not pin community-vs-community order** — the engine uses
  it to place the mod after the official cores and handles that itself. Only
  `<DependedModuleMetadata order="LoadBeforeThis|LoadAfterThis">` pins one community mod
  relative to another. When neither exists, position among community mods is genuinely
  free: say so rather than inventing a constraint.

Two post-install checks that decide whether a C# mod can load at all, both cheap:

- **`Zone.Identifier` on the real DLL** (follow the Vortex symlink to the staging copy):
  a blocked DLL crashes before the main menu, and the symptom points nowhere near the cause.
- **A `ConfusedBy` marker in the DLL** — presence means ConfuserEx obfuscation and therefore
  unreadable class/method names in crash logs. Absence means the crash report is usable.
  Note that a type's full name (`Ns.Type`) is *not* stored contiguously in metadata, so
  searching for `"Ns.Type"` as one literal returns false; search the name segment instead.

## Inventory sources, in order of authority

| Source | Trustworthy for |
|---|---|
| `_MODULES_*...*_MODULES_` in `rgl_log_<pid>.txt` | what actually loaded, and in what order |
| `Modules/<X>/SubModule.xml` | declared id, version, type, dependencies, XML tables |
| `LauncherData.xml` | what the user ticked, and the launcher's stored order |
| Vortex `*_loadorder.json` | Vortex's own view only — **not** selection state |

`LauncherData.xml` and the Vortex load-order file disagree about `isSelected` in practice.
LauncherData is the one the launcher acts on.

### LauncherData.xml schema

It is **not** a list of `<Module Id="..">` elements. Each entry is:

```xml
<UserModData>
  <Id>Bannerlord.Harmony</Id>
  <LastKnownVersion>v2.4.2.248</LastKnownVersion>
  <IsSelected>true</IsSelected>
</UserModData>
```

nested under `<SingleplayerData><ModDatas>` and `<MultiplayerData><ModDatas>`. The order
of `<UserModData>` blocks is the stored load order. A regex looking for `<Module\b`
matches nothing and yields a silently empty result — which is easy to misread as "the
file is missing" when the path is in fact correct. Verify the parse produced a non-empty
list before trusting a "not found" conclusion.

The file lives under the user's Documents (`Documents\Mount and Blade II Bannerlord\
Configs\`), which may be a localised folder name or redirected to OneDrive.

## Two classification traps

**Official optional modules are shipped by the game.** `BirthAndDeath`, `FastMode` and
`NavalDLC` carry `<ModuleType value="OfficialOptional"/>` and a version matching the game
build. They are TaleWorlds' own optional modules, not community downloads. Confirm by
checking they are real files rather than Vortex deployment links, and by the version
matching `Modules/Native/SubModule.xml`.

**A module folder's `Id` need not match its folder name.** In 1.4.x the folder is
`SandBox` but its declared `<Id>` is `Sandbox` — lowercase b. Every vanilla dependent
(`StoryMode`, `NavalDLC`) and every community mod tested declares `Id="Sandbox"` to
match. A mod author writing `Id="SandBox"` gets a lookup failure. Compare case-
insensitively when classifying, but do not "correct" the case in generated files.

## Things that look like errors and are not

- **`BLSE.AssemblyResolver` reported as a missing dependency.** It is a virtual module
  exposed by BLSE's own binaries. It never exists as a folder. Suppress the warning when
  BLSE is present in `bin/Win64_Shipping_Client`.
- **A community mod bundling `0Harmony.dll`.** `RTSCamera`, `RTSCamera.CommandSystem`
  and `Warbandlord` all ship one alongside `Bannerlord.Harmony`'s copy. Worth reporting as
  a low-grade risk, but mods doing this are routinely loadable.
- **A mod whose declared version differs from the game version.** Harmony 2.4.2.248,
  MCM 5.12.3 and SiegeAIFix 1.8.3 have their own versioning schemes; comparing them to
  "v1.4.8" produces a wall of false positives. Only treat a version as meaningful when
  the mod version follows the game's `1.x.y` pattern, or when the module ships
  per-version implementation DLLs (`*.Implementation.<gamever>.dll`) and the one matching
  the installed build is absent.

## Detecting mods that have never actually run

Compare each module folder's mtime against the newest `rgl_log_*.txt` that contains a
`_MODULES_` chain. A folder newer than the last launch cannot have loaded, and absence
from every recorded chain confirms it. In the observed install, three mods were deployed
13 seconds *after* the last successful launch — present on disk, ticked in the launcher,
and completely untested. That is the highest-value thing an inventory scan can surface,
and it is invisible if you only read `LauncherData.xml`.

Use second-resolution timestamps for this comparison. Minute resolution renders
"00:13:22 vs 00:13:09" as "00:13 vs 00:13" and silently destroys the evidence.

## Where BLSE actually lives

`Bannerlord.BLSE.Launcher.exe`, `Bannerlord.BLSE.Standalone.exe` and
`Bannerlord.BLSE.Shared.dll` live in `bin/Win64_Shipping_Client/`, **not** in the game
root. A root-level `vortex.deployment.bannerlord-blse.json` is only a deployment
manifest left behind by Vortex and does not mean the binaries are missing. Check the
`bin` directory before concluding BLSE is uninstalled.

`bin/Win64_Shipping_wEditor/` remains the Modding Kit indicator: its absence means no
Scene Editor and no asset pipeline.

## Vortex staging folder naming

`<ModName> <nexusModId|fileId> <version> <ISOdate> <hash>`, e.g.
`RTS Camera and Command for Bannerlord v1.4.x 355 v5.4.16 2026-08-23T08-51Z JSEAp7xON`
and `Warbandlord 1.4.7 3961 1.4.0.3 2026-08-02T18-59Z 3diFBZawf` (Nexus mod 3961,
matching the `Url` declared in that module's `SubModule.xml`). The staging copy and the
deployed `SubModule.xml` can disagree on version if the author forgot to bump it — check
both before reporting a version.

### Which level is actually linked — get this wrong and you will misread the deployment

The link is **not** on the module folder. It is on the files **inside** it. Measured on a real install whose
staging folder is on `C:` and game on `G:` (cross-volume, so symlinks rather than hardlinks):

| Level | Reality |
|---|---|
| `Modules/<Mod>/` — the top-level folder | an **ordinary directory**, no reparse attribute |
| `Modules/<Mod>/**` — the files within | mostly **reparse points** (24 of 44 entries in one sampled module; 128 of 186 in another) |

```
Modules/Warbandlord/SubModule.xml
  size = 0     reparse = True     attrs = 0x420    (0x400 reparse | 0x20 archive)
```

Three successive checks each reported "no symlink deployment" before the right level was tested:
`os.path.islink(<dir>)` → False; the reparse attribute of `<dir>` → false for all 25 modules; the reparse
attribute of the **files inside** → hit. Note also that `os.path.islink` returns False for a Windows
**junction** (its reparse tag is `IO_REPARSE_TAG_MOUNT_POINT`, which Python does not treat as a symlink) —
test `st_file_attributes & 0x400` instead.

**Consequences:**

- Deployed files report `Length = 0`. **File size is never evidence of deployment health.**
- The deployment manifest (`vortex.deployment.bannerlord-module.json`) records
  `{relPath, source, target, time}` per file. `source` is the **staging folder name**, formatted
  `<ModName> <NexusId> <version> <ISOdate> <hash>` — e.g.
  `ButterLib 2018 2.12.0 2026-08-23T20-13Z mPUXeCuml`, which hands you the Nexus mod id directly.
  `target` is an **empty string**; the link destination is not in the manifest at all.

### Listing a symlink-deployed module's real contents

A deployed module surfaces as `__folder_managed_by_vortex` placeholder files plus zero-byte
symlinks; the payload lives in the staging folder. `Glob` and `find -type f` follow neither,
so a normal recursive listing returns **only the placeholder directories** and reads exactly
like an empty/abandoned deployment. Enumerate with link targets instead, and use the
resolved `Target` as the path for any follow-up read:

```powershell
Get-ChildItem -LiteralPath $modDir -Recurse -Force -File |
  ForEach-Object { "{0} {1} -> {2}" -f $_.Length, $_.FullName, ($_.Target -join ";") }
```

Practical consequence for edits: never drop a hand-made patch into the deployed path. Vortex
overwrites it on the next deployment. Change the staging copy, or purge/redeploy first.
