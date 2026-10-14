# C# development: assemblies, templates, core classes

Everything here was verified name-by-name against the shipped official assemblies.

## 1. Which assembly to reference

| Type / member | Assembly |
|---|---|
| `MBSubModuleBase` and all its lifecycle methods | `TaleWorlds.MountAndBlade.dll` |
| `MBObjectManager`, `MBObjectBase`, `RegisterType`, `GetObjectType` | `TaleWorlds.ObjectSystem.dll` |
| `MBObjectManagerExtensions` | `TaleWorlds.Core.dll` / `CampaignSystem.dll` / `MountAndBlade.dll` — **not** in ObjectSystem |
| `GameModel`, `IGameStarter`, `AddModel`, `CultureObject`, `CharacterObject`, `ItemObject` | `TaleWorlds.Core.dll` (and CampaignSystem / MountAndBlade) |
| `CampaignGameStarter`, `CampaignBehaviorBase`, `AddBehavior`, `PartyTemplateObject` | `TaleWorlds.CampaignSystem.dll` |
| `MissionBehavior`, `OnMissionBehaviorInitialize` | `TaleWorlds.MountAndBlade.dll` |
| `TextObject` | `TaleWorlds.Localization.dll` |
| Harmony patching | `Modules/Bannerlord.Harmony/bin/Win64_Shipping_Client/0Harmony.dll` |

All game assemblies live in `<root>/bin/Win64_Shipping_Client/`.
`PartyTemplateObject` is only found in CampaignSystem (unlike `CultureObject`, which is in three).

## 2. SubModule class template

```csharp
using TaleWorlds.MountAndBlade;   // MBSubModuleBase
using TaleWorlds.Core;            // Game, IGameStarter, GameModel
using TaleWorlds.CampaignSystem;  // CampaignGameStarter

namespace MyMod
{
    public class MySubModule : MBSubModuleBase
    {
        protected override void OnGameStart(Game game, IGameStarter gameStarter)
        {
            base.OnGameStart(game, gameStarter);
            CampaignGameStarter c = gameStarter as CampaignGameStarter;
            if (c != null)
            {
                c.AddModel(new MyModel(game));
                c.AddBehavior(new MyBehavior());
            }
        }
    }
}
```

- `OnSubModuleLoad` / `OnGameStart` are `protected internal virtual` in the engine ⇒ a cross-assembly
  override **must** be declared `protected`, or it is inaccessible.
- Models and behaviors can only be registered in `OnGameStart`, once you hold the `IGameStarter`.

### Lifecycle methods (all verified present)

| Method | Timing (inferred) |
|---|---|
| `OnSubModuleLoad` | module load |
| `OnBeforeInitialModuleScreenSetAsRoot` | before the main menu |
| `OnGameInitializationFinished` | game init complete |
| **`OnGameStart(Game, IGameStarter)`** | **the registration entry point** |
| `OnNewGameCreated` | a new campaign was created |
| `OnGameLoaded` | save loaded |
| `OnGameEnd` | campaign / battle ended |
| `OnMultiplayerGameStart` | multiplayer session start |
| `OnApplicationTick(float)` | every frame |
| `OnMissionBehaviorInitialize(Mission)` | entering a mission (battle / scene) |
| `OnSubModuleUnloaded` | module unload |

## 3. Harmony patch template

```csharp
using HarmonyLib;

[HarmonyPatch(typeof(SomeEngineType))]
[HarmonyPatch("SomeMethod")]
internal static class SomeMethodPatch
{
    private static void Postfix(ref int __result) { __result += 1; }
}
```

- A **method-level** patch on an engine **static** type is **immune** to model replacement. Only a class-level
  bare `[HarmonyPatch]` plus a runtime `TargetMethod()` name lookup can be killed by another mod replacing the model.
- One-line discrimination rule: **abstract-contract member vs concrete-class private helper.**
  Virtual members are necessarily re-declared by the override and are still found; private helpers of the
  concrete class (e.g. `UpdateHumanStats`) are not.
- "The model was replaced" ≠ "every patch on that model dies". Do not overstate the blast radius.
- **Before concluding there is no call site to hook, disassemble the first instructions of the override** —
  a *wrapper model* holds `_previousModel` and `callvirt`s it, so the original methods **do** run and the patch
  target exists. That turns "unfixable" into roughly a 100-line shim.
- Patch order is irrelevant; `AddModel` registration is launcher-ordered with the last registration of a given
  base type winning. A patcher and a model-replacer **coexist** — reordering them is advice about nothing.
- Harmony 2.4+ locates `Prepare` / `TargetMethod` / `Cleanup` via **marker types**
  (`HarmonyLib.HarmonyTargetMethod` etc.), not string names — grepping `0Harmony.dll` for `"TargetMethod"`
  finds nothing.

## 4. `MBObjectManager` — the runtime field-edit route

```csharp
using TaleWorlds.ObjectSystem;

MBObjectManager mgr = MBObjectManager.Instance;
var culture = mgr.GetObject<CultureObject>("empire");  // bare id, no prefix
mgr.RegisterObject(myObject);                          // register / override by string id
mgr.CreateObject<CultureObject>("my_culture");         // create
```

- Verified present: `MBObjectManager`, `MBObjectBase`, `Instance`, `GetObject`, `CreateObject`,
  `RegisterObject`, `RegisterType`, `GetObjectType`.
- Extension methods live in `MBObjectManagerExtensions`.
- **Keys are bare string ids** (`"empire"`), **not** the prefixed XML form (`Culture.empire`).
- `RegisterType` is required when introducing a new object type.

## 5. `PerkObject` is code-only

- It is **not definable in ModuleData XML**. XML only declares a troop's `<skills>`; constructing, granting and
  applying perks happens entirely in C#.
- Consequence: a pure-XML module **cannot** add perks.

## 6. Text in code

```csharp
var text = new TextObject("{=MyKey}Default English");
```

- Even with zero UI dependencies this routes through the localization system and is translatable by a language pack.
- Key convention: 8 alphanumeric characters. On a miss the game falls back to the English text after `{=…}`.

## 7. Compile constraints (measured on this machine)

Compiling inside the sandbox is blocked on every route:

```
csc.exe                    → Command blocked for security (equivalent to Add-Type)
Add-Type -OutputAssembly   → Command blocked for security
ilasm.exe                  → Command blocked for security (known LOLBin)
cmd.exe                    → not callable from the shell tool ⇒ build.bat can never be launched by the agent
dotnet                     → the `dotnet` on PATH is runtime only (NETCore.App / WindowsDesktop.App 9.0.19);
                             `dotnet --list-sdks` returns EMPTY **for that instance**.
```

**A system-wide SDK does exist — verified 2026-09-26 by listing `C:\Program Files\dotnet\sdk` → `8.0.425`.**
There are two separate dotnet installs; never conclude "this machine has no SDK" from one empty
`--list-sdks`. Note also that SDK 8 cannot target net472 out of the box (it needs the
`Microsoft.NETFramework.ReferenceAssemblies.net472` NuGet package), so for a Bannerlord mod DLL the
Framework64 `csc.exe` below is still the shorter path.

### The block is on the agent, not on the machine

Say this plainly to the user when it comes up: the `Command blocked for security` message is a control on
**commands the agent runs**, not a Windows restriction and not a restriction on the user. The user
compiling in their own PowerShell/CMD/VS is unaffected. Do not phrase it as "this machine cannot
compile C#" — that is wrong and it needlessly closes off the option. Correct phrasing: *I can't run the
compiler; you can, with one command.*

Compiler inventory on this machine (measured):

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe      present
C:\Program Files\dotnet\dotnet.exe  + sdk\8.0.425            present
C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools  present
```

Target framework for Bannerlord 1.4.8 mods: **net472** — measured from
`ImprovedCombatAI.dll`'s `TargetFrameworkAttribute` (`.NETFramework,Version=v4.7.2`). Existing mods'
own attribute agrees where present.

### Closing the loop without a compiler

Deliver `.cs` + `SubModule.xml` + `build.bat`, then **verify the built artifact with `scripts/netmeta.py`**
once the user has run the batch: confirm the TypeDef exists, `extends` is what you intended, and the
expected fields are there. That turns "I can't compile so I can't check" into a real check.

**Do not route around it** (a different host process, a Roslyn assembly loaded with `Add-Type -Path`, or a
Cecil-based IL emitter are all evasions, not solutions). **The build step is inherently the user's.**

**2026-09-23 update — the block is on the command *text*.** Invoking the runtime at all is now rejected
before it runs: `Known Windows LOLBin that can execute arbitrary code outside command validation`. This
matters because the blacklist matches the literal command string, so merely *naming* one of these binaries
inside a probe refuses the whole call — a read-only existence test on the compiler path was rejected with
`csc.exe compiles arbitrary C# code (equivalent to Add-Type)`, and a follow-up list-only command survived.
Two consequences: (1) treat the compiler as unreachable and stop probing for it; (2) a "command blocked"
result is **not** evidence that the tool is absent from the machine — VS 2022 is in fact installed here.

Deliver `.cs` + `SubModule.xml` + a `build.bat`:

```
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
  /r:<root>\bin\Win64_Shipping_Client\TaleWorlds.*.dll
  /r:<root>\Modules\Bannerlord.Harmony\bin\Win64_Shipping_Client\0Harmony.dll
  /r:%WINDIR%\…\System.dll  /r:%WINDIR%\…\System.Core.dll
  /target:library /platform:x64 /out:<mod>\bin\Win64_Shipping_Client\MyMod.dll
```

- **Keep the C# to C# 5 syntax**: that compiler is C# 5 — no string interpolation, no expression-bodied members,
  no `?.`, no `nameof`, no `out var`.
- A 4.0-targeted assembly loads fine on the game's 4.7.2 runtime.
- With no compiler feedback, pre-verify source against the real assemblies with **Mono.Cecil**: for every API,
  confirm existence **and accessibility** (e.g. `MBSubModuleBase.OnSubModuleLoad` is `protected internal`, so the
  override must be `protected`), check for type-name ambiguity across your `using` set, and brace/paren-balance
  the file.

## 8. Probing techniques that silently give wrong answers

- `Assembly.LoadFrom` + `GetTypes()` — throws `LoaderExceptions` and yields a partial or empty type list **with no error**.
- PowerShell 5.1 `Add-Type` reflection probes — return NULL even for members confirmed present.
- **Searching for a full compound type name as one byte string.** Metadata `#Strings` heap entry ordering and
  Windows path/case conventions make this unreliable: searching `MbObjectManager` **misses** (the real name is
  `MBObjectManager`), while `MbObject` **hits** — on a different real type, `MbObjectXmlInformation`. Either
  result on its own will confirm a wrong conclusion.

**Discipline: a search HIT is trustworthy; a MISS is not evidence — change the name segment or the method, then
re-run.** Corollary: bannerlord managed types use the **`MB`** prefix (both letters uppercase) —
`MBSubModuleBase`, `MBObjectManager`, `MBObjectBase`.

## 9. Core-class quick reference — verification note

Every name above was verified by scanning the shipped `TaleWorlds*.dll` files for the name string. Names marked
as absent (`RegisterSubModuleTypeDefinition`, `RemoveObject`, `GetRegisteredTypes`) are **neither asserted nor
denied** — they were not found by this method and were not followed up.
