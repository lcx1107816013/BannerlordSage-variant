# Module structure: SubModule.xml and the pure-file layout

## 1. SubModule.xml

Path: `Modules/<ModuleId>/SubModule.xml`. Encoding **UTF-8** (BOM optional — official modules use both:
`Native` has one, `SandBoxCore` does not; **none** is UTF-16).

### 1.1 Metadata elements

| Element | Present in official | Values |
|---|---|---|
| `<Name value>` | all | display name, may contain spaces (`"SandBox Core"`) |
| `<Id value>` | all | module id; **should equal the folder name** (one exception below) |
| `<Version value>` | all | `v1.4.8` style. **The only source of game version** — the exe reports `1.0.0.0` |
| `<RequiredBaseVersion value>` | optional | the **required game version**, independent of `Version`. Official `NavalDLC` writes `Version="v1.2.8"` + `RequiredBaseVersion="v1.4.8"` — **judge game compatibility by the latter** |
| `<ModuleType value>` | **9/9** | `Official` / `OfficialOptional`; community modules use `Community` |
| `<ModuleCategory value>` | 6/9 | `Singleplayer` / `Multiplayer` |
| `<DefaultModule value>` | 6/9 | `true` / `false` |
| `<SingleplayerModule value>` | 2/9 | `true` |

**Two parallel forms — pick one.** `ModuleCategory` + `DefaultModule` (SandBoxCore / SandBox / StoryMode /
CustomBattle / Multiplayer / NavalDLC) **or** `SingleplayerModule` (BirthAndDeath / FastMode).
`Native` uses neither and declares only `ModuleType`.

**Three robustness facts** (measured on official `NavalDLC`):

- `Optional` value is **case-insensitive**: it actually writes `Optional="False"`.
- Attribute order in `DependedModule` is **irrelevant**: it writes `Id` after `Optional` and `DependentVersion`.
- The `SandBox` folder's declared `Id` is **`Sandbox`** (lowercase b). Official modules depend on it as
  `Id="Sandbox"`; writing `Id="SandBox"` causes a lookup failure. Compare case-insensitively, but do **not**
  "normalise" the case when generating files.

> `<Version value = "v1.4.8"/>` may have **spaces around `=`** — a regex demanding exactly one space silently fails.

### 1.2 Dependencies and ordering

```xml
<DependedModules>
  <DependedModule Id="Native" DependentVersion="v1.4.8" Optional="false"/>
</DependedModules>
<ModulesToLoadAfterThis>
  <Module Id="OtherMod"/>
</ModulesToLoadAfterThis>
<IncompatibleModules>
  <Module Id="ConflictingMod"/>
</IncompatibleModules>
```

- `Optional="false"` → the module does not load if the dependency is missing.
- The latter two may be self-closing empty elements (official `Native` does this).
- `DependentVersion` is optional; pinning it makes the module break on every game patch — omit unless a hard dependency truly exists.
- Actual order is decided by the engine log's `_MODULES_` line, not by the launcher's tick state.

### 1.3 SubModules — the C# entry points

```xml
<SubModules>
  <SubModule>
    <Name value="MySubModule"/>
    <DLLName value="MyMod.dll"/>
    <SubModuleClassType value="MyMod.MySubModule"/>
    <Tags>
      <Tag key="DedicatedServerType" value="none"/>
      <Tag key="IsNoRenderModeElement" value="false"/>
    </Tags>
  </SubModule>
</SubModules>
```

- `DLLName` is a bare filename; the DLL lives in `Modules/<ModuleId>/bin/Win64_Shipping_Client/`.
- `SubModuleClassType` must derive from `MBSubModuleBase` and be fully namespace-qualified.
- Extra assemblies go in a sibling `<Assemblies><Assembly value="X.dll"/></Assemblies>`.
- A pure-XML module writes `<SubModules />` (official `SandBoxCore` does exactly that).

### 1.4 Xmls — data-table registration

```xml
<Xmls>
  <XmlNode>
    <XmlName id="Items" path="mymod_items"/>
    <IncludedGameTypes>
      <GameType value="Campaign"/>
      <GameType value="CampaignStoryMode"/>
    </IncludedGameTypes>
  </XmlNode>
</Xmls>
```

- `path` is relative to `Modules/<ModuleId>/ModuleData/` and **has no `.xml` suffix**.
  **An undeclared table is never loaded** — the single most common cause of "my module does nothing".
- `id` is the **data-table type name** that selects the parser, **not a filename**: official `Native` uses
  `id="Items" path="mpitems"`, `SandBoxCore` uses `id="Items" path="items"`.
- `IncludedGameTypes` values seen in official modules: `Campaign`, `CampaignStoryMode`, `CustomGame`,
  `EditorGame`, `MultiplayerGame`.
- **One `id` may have several `XmlNode`s**: official `SandBoxCore` uses three `id="NPCCharacters"` nodes for
  `spnpccharactertemplates` / `spnpccharacters` / `obsolete_characters`.

---

## 2. Pure-file module layout

### 2.1 Minimal structure

```
<game root>/
├── bin/Win64_Shipping_Client/          game binaries — read-only, never touch
└── Modules/
    ├── Native/  SandBoxCore/  SandBox/ …   official modules — read-only, never touch
    └── <YourMod>/
        ├── SubModule.xml
        └── ModuleData/
            ├── <table>.xml           one file per declared <XmlName path>
            ├── items/                only when using the per-category item split
            └── Languages/
                └── <locale>/          e.g. CNs
                    ├── language_data.xml
                    └── <name>.xml
```

A **pure-XML module needs no `bin/`** — `SubModules` is `<SubModules />`. Only C# modules need
`bin/Win64_Shipping_Client/`.

### 2.2 Worked example (troop + localization)

```
Modules/HouseholdGuards/
├── SubModule.xml
└── ModuleData/
    ├── spnpccharacters.xml
    └── Languages/CNs/
        ├── language_data.xml
        └── std_householdguards-zho-CN.xml
```

```xml
<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Household Guards" />
  <Id value="HouseholdGuards" />
  <Version value="v1.0.0" />
  <ModuleCategory value="Singleplayer" />
  <DependedModules>
    <DependedModule Id="Native" Optional="false" />
    <DependedModule Id="SandBoxCore" Optional="false" />
    <DependedModule Id="Sandbox" Optional="false" />
  </DependedModules>
  <SubModules />
  <Xmls>
    <XmlNode>
      <XmlName id="NPCCharacters" path="spnpccharacters" />
      <IncludedGameTypes>
        <GameType value="Campaign" />
        <GameType value="CampaignStoryMode" />
        <GameType value="CustomGame" />
        <GameType value="EditorGame" />
      </IncludedGameTypes>
    </XmlNode>
  </Xmls>
</Module>
```

- `Id="Sandbox"` — **lowercase b**.
- Omit `DependentVersion` unless a hard dependency exists.
- Omitting `<ModuleType>` still loads, but community modules normally declare `Community`.

`ModuleData/spnpccharacters.xml` — **only the objects you add or override**:

```xml
<?xml version="1.0" encoding="utf-8"?>
<NPCCharacters>
  <NPCCharacter id="hg_guard" name="{=hgGuard}Household Guard"
                default_group="Infantry" level="16"
                occupation="Soldier" culture="Culture.empire">
    <face><face_key_template value="BodyProperty.fighter_empire" /></face>
    <skills><skill id="Athletics" value="80" /></skills>
    <upgrade_targets></upgrade_targets>
    <Equipments>
      <EquipmentRoster>
        <equipment slot="Item0" id="Item.empire_sword_1_t2" />
        <equipment slot="Head"  id="Item.arming_coif" />
      </EquipmentRoster>
    </Equipments>
  </NPCCharacter>
</NPCCharacters>
```

Do **not** copy the whole vanilla `spnpccharacters.xml` (1.2 MB) "to be safe" — that is a bug: it bloats the
download and freezes vanilla content at the moment you copied it.

### 2.3 Placement rules

| Rule | Why |
|---|---|
| Folder name = the `<Id>` value | the loader associates the module by Id |
| `path` is relative to `ModuleData/`, no extension; nested files are written `items/mymod_items` | the engine resolves the file from this |
| Overriding an existing object = **redeclare the whole element** (extract vanilla byte-exact, edit only the target fields) | there is no field-level merge |
| Ship only what you add or override | copying whole tables freezes vanilla |
| Deleting the module folder rolls back losslessly | except save-game references to removed custom objects |
| **Never edit files inside official module folders** | override through your own module |
| **Never edit files under a Vortex-deployed path** | the next deployment overwrites them; edit the staging copy |
| Keep a copy of any localization files outside the game directory | Vortex purge/redeploy removes them |

### 2.4 Pre-delivery checklist

- [ ] every data file's `path` is **declared in `<Xmls>`**
- [ ] `id` is the **table type name** (`NPCCharacters`), not the filename (`spnpccharacters`)
- [ ] the three encodings match §2.5 byte-for-byte
- [ ] `<Id>` matches the folder name; a `Sandbox` dependency is **lowercase b**
- [ ] overridden elements were **extracted byte-exact**, with only the target fields changed
- [ ] `validate_refs.py` was run **and every reference category has a non-empty count**
- [ ] `probe_game.py` confirms the version and that the tables exist on it
- [ ] localization: `language_data.xml`'s `id` matches the in-game `Language=` setting
- [ ] the report separates: what was statically verified / what was not / what remains uncertain

### 2.5 Encoding per file

| File | Encoding | Evidence |
|---|---|---|
| `SubModule.xml` | UTF-8 (BOM optional) | official 9 modules: 3 with BOM, 6 without, none UTF-16 |
| `ModuleData/<table>.xml` | **UTF-8 + BOM** | official tables 6/6 start `ef bb bf` |
| `.../Languages/<locale>/language_data.xml` | **UTF-16 LE + BOM** | official 2/2 start `ff fe 3c 00` |
| `.../Languages/<locale>/<name>.xml` | **UTF-16 LE + BOM** | same batch |
| `ModuleData/XSLT/*.xslt` | declares `encoding="utf-8"` | read from official `NavalDLC` XSLT (not byte-checked) |

`<locale>` uses short codes (official: `CNs`, `CNt`, `BR`, `DE`, `FR`). `language_data.xml`'s `id` is the
**display name** (`简体中文`) and its `xml_path` is **relative to `Languages/`**.

### 2.6 The generator, and its two defects

```bash
python scaffold_module.py new --id MyHouseholdGuards --name "Household Guards" --dir ./MyHouseholdGuards \
    --table NPCCharacters:spnpccharacters --locale CNs:简体中文

python scaffold_module.py extract --root "<root>" \
    --table SandBoxCore/ModuleData/spnpccharacters.xml \
    --element NPCCharacter --id imperial_recruit --out recruit.xml
```

**Two things to hand-correct in the generated `SubModule.xml`** (recorded, not fixed, to keep the script
diffable against upstream):

1. It hard-codes `<DependedModule Id="SandBox" />` — **capital B**. The official declaration, and the same
   package's `list_load_order.py`, both use `Sandbox`. Fix it.
2. `KNOWN_TABLES` maps `"PartyTemplates" → "spnpccharactertemplates"`, but that file's official `id` is
   `NPCCharacters`, and the party-template table's official `id` is `partyTemplates` (lowercase p, see
   `NavalDLC`). `root_tag_for()` likewise maps it to a `<PartyTemplates>` root with no official basis.

Also note `validate_refs.py` does **not** check dependency-id validity, so it will report **PASS** on defect 1.
