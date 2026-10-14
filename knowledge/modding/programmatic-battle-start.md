# Programmatically Starting a Battle (a custom mission)

Symptom that brings you here: a mod calls `MissionState.OpenNew(...)` to run an AI-vs-AI (or
otherwise player-less) battle, and the mission **opens but never runs** — `Mission.CurrentTime`
freezes at a fraction of a second, no agents act, and the game may crash tens of seconds later
inside `Mission.OnTick`. Root cause in every case seen so far: **the mission was never told that
the initial troop spawn finished.**

## 1. The two-path rule (official, easy to miss)

From TaleWorlds' patch notes (WS v1.3.0 / BL v1.5.0):

> `OnDeploymentFinished` is now a mission object and mission behavior callback that is called for
> all mission types after the initial troop spawn.
>
> If you have a **custom deployment mission controller behavior** (which you add to the Mission as
> a behavior) and which extends from the `DeploymentMissionController` abstract class, then you
> need to call **`Mission.OnDeploymentFinished()`** when you finish spawning the initial troops and
> when the deployment phase is completed.
>
> If you **don't have** a deployment mission controller behavior and if you just have a custom
> mission controller (which controls the mission flow), then you need to call
> **`Mission.OnInitialSpawnCompleted(BattleSide)`** during or after mission loading is finished. It
> could be in `AfterMissionLoadingFinished()` or within `OnMissionTick()`.
>
> Both pathways notify the mission that all initial troops and deployable entities are spawned. So
> the mission sends notification messages to all mission objects and behaviors to initialize
> themselves accordingly.

**Pick exactly one path and actually call it.** Hand-assembling a behavior list from engine pieces
(`MissionCombatantsLogic` + `DefaultBattleMissionAgentSpawnLogic` + `CustomBattleMissionSpawnHandler`
+ `AgentHumanAILogic` + …) does **not** make the engine call these for you — the list has no
`Deployment*` member, so you are on the **"custom mission controller"** branch and the
`OnInitialSpawnCompleted(BattleSide)` call is yours to make. Grep for it before assuming:
`grep -rn "OnInitialSpawnCompleted\|OnDeploymentFinished" src/` — **0 hits means the mission can
never finish initialising.**

## 2. Why the failure looks like a freeze

`MissionAgentSpawnLogic` (official API doc) exposes:

| Member | Meaning |
|---|---|
| `IsInitialSpawnOver` | *"true only when initial set of troops are spawned for both sides. Order of battle deployment phase may or may not be finalized yet."* |
| `IsDeploymentOver` | *"true when initial troops are spawned and Order of Battle deployment phase is finalized by starting the mission."* |
| `InitWithSinglePhase(defenderTotalSpawn, attackerTotalSpawn, defenderInitialSpawn, attackerInitialSpawn, spawnDefenders, spawnAttackers, in spawnSettings)` | single-phase spawn config; `spawnDefenders`/`spawnAttackers` = spawn immediately, else let mission logics decide |
| `StartSpawner(side)` / `StopSpawner(side)` / `SetSpawnTroops(side, bool, enforceSpawning)` | manual spawn control |
| `OnBattleSideDeployed(side)` | notify that a side has deployed |
| `IsSideDepleted(side)` / `GetTotalNumberOfTroopsForSide(side)` | progress checks |

`IsInitialSpawnOver` is driven by `OnInitialSpawnForSideEnded(side)`. With nothing sending that
notification it stays **false forever**, so the mission sits in "waiting for the initial spawn to
complete": `Mission.CurrentTime` (the telemetry value a bridge would log as `missionTime`) stays
pinned near `0`, per-frame counters stay at `0`, and callbacks that gate on deployment never fire.

**Log these two properties first.** Adding `IsInitialSpawnOver` / `IsDeploymentOver` to your
telemetry turns a multi-hour guess into a one-run diagnosis.

Related trap: `IsInitialSpawnOver` is the one property in that batch that dereferences its phase
objects **without** a null-conditional. If spawning never started, reading it can throw
`NullReferenceException` from inside the engine's `Mission.OnTick` — which reads as "mission crashes
the moment it is created" rather than "mission is stuck". Guarding the read is correct but does not
fix the stuck mission; only sending the completion notification does.

## 3. Knock-on effect: third-party patches on the deployment callback

Mods legitimately Harmony-patch `Mission.OnDeploymentFinished`. Measured in RTSCamera
(`RTSCamera.decompiled.cs:8992`), patched together with the time-speed method:

```csharp
harmony.Patch(typeof(Mission).GetMethod("UpdateSceneTimeSpeed", ...), Prefix_UpdateSceneTimeSpeed);
harmony.Patch(typeof(Mission).GetMethod("OnTeamDeployed", ...),      Prefix_OnTeamDeployed);
harmony.Patch(typeof(Mission).GetMethod("OnDeploymentFinished", ...), Prefix_OnDeploymentFinished);
harmony.Patch(typeof(Mission).GetMethod("CanTakeControlOfAgent", ...), Prefix_CanTakeControlOfAgent);
```

A mission that never fires `OnDeploymentFinished` therefore **never runs those prefixes** — so
features which depend on them (free-camera switching, RTS-view initialisation) silently do nothing
even though their UI is present and clickable. "The button is there but does nothing" is a genuine
clue pointing back at the missing notification, not a separate UI bug.

## 4. Injecting mission behaviors — the correct hooks

| Hook | When it works |
|---|---|
| `MBSubModuleBase.OnMissionBehaviorInitialize(Mission)` | every mission, including custom ones — the general answer |
| `MBSubModuleBase.OnBeforeMissionBehaviourInitialize(Mission)` | works for Custom Battle missions; the safe choice when you need to add before others initialise |
| `OnGameStart` + `Mission.Current.AddMissionBehavior(...)` | **anti-pattern** — works in campaign, fails for Custom Battle / custom missions |

## 5. Scene (map) constraints — data completeness is a hard limit

From the README of **EnhancedBattleTest** — an MIT-licensed mod that does exactly this job
(programmatic battles, per-side troop groups, spectating AI-vs-AI). Its author (`LiZhenhuan1019` /
`modbed`) is also the author of **RTSCamera**, whose decompiled source is a good worked example:

- *"Custom battle mode contains sergeant maps only, because only sergeant maps contains correct
  spawning positions that custom battle mode requires."* → a map with no spawn-position data for
  the mode you are in will fail, regardless of how correct your code is.
- *"Siege maps may crash. Due to incompleteness of AI navigation mesh and other entities in siege
  maps, AI may perform poorly in those maps."*
- *"If the game crashed when loading a siege battle or clicking 'Begin assault', try to change the
  scene level. Some scenes lacks data for some scene level"* → **scene × scene-level** is the real
  key; a scene may be fine at one level and missing data at another.
- *"If you want more maps, you can edit the config file yourself … or the game may crash."*

So: verify the scene you pass to `MissionInitializerRecord` is valid **for the battle size you are
spawning**, and prefer the maps the engine's own Custom Battle path uses.

## 6. Checklist before blaming your own logic

1. `grep -rn "OnInitialSpawnCompleted\|OnDeploymentFinished" src/` — non-zero?
2. Does the behavior list contain any `DeploymentMissionController` subclass? If **no**, you are on
   the custom-controller branch and must call `Mission.OnInitialSpawnCompleted(BattleSide)`.
3. Is `MissionState.OpenNew`'s `addDefaultMissionBehaviors` argument `true`? If it is, the engine
   **may already be adding its own spawn/deployment behaviors** — check before adding a spawn logic
   of your own, or two spawn systems will coexist. (Exact semantics of every overload are not
   documented; confirm against the shipped assembly rather than assuming.)
4. Is the scene a valid spawn-capable map for this battle size / scene level?
5. Log `IsInitialSpawnOver` and `IsDeploymentOver` on a timer; both should flip within a second of
   the mission starting. If they never flip, it is item 1 or 2.

## 7. Getting a method-level stack when it still crashes

`dump.dmp` needs a debugger (`cdb.exe` from the Windows SDK, or Visual Studio) — check for it
before promising analysis. Cheaper alternative: **ButterLib's CrashUploader** uploads the report to
`https://butr.dev` and returns a `report.butr.link/<id>` link containing **IL offsets and per-frame
method attribution**, with no debugger installed. Tell the user to click "upload" on the next crash.

## 8. Reference projects

| Project | Why it matters |
|---|---|
| **EnhancedBattleTest** (`github.com/jffifa/EnhancedBattleTest`, fork `cookgreen/EnhancedBattleTest`, MIT) | the closest prior art: programmatic battles, up to 8 troop groups per side, AI-vs-AI spectating; README documents the scene constraints above |
| **Virtual BattleGrounds** (continuation of Enhanced Battle Test) | same lineage, still maintained; its *Free Battle* mode can place troops at arbitrary spawn points, whereas *Custom Battle* mode is restricted by the spawn data the map carries |
| **Realistic Battle Mod (RBM)** | ships a "spectate AI battle" feature and **requires RTSCamera to be installed** to use it — evidence that "bridge + RTSCamera spectating" is the established shape for this feature |
| **Auto Battle Overhaul** (Nexus 11121) | the opposite approach: a purely mathematical multi-stage simulation (ranged → cavalry → anti-cavalry → melee → morale) that **never opens a real mission**. The fallback when live-mission runs stay fragile — at the cost of no longer measuring real engine behaviour |
