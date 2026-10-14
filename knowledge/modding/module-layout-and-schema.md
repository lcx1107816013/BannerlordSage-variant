# Bannerlord module layout, schema map, and load semantics

Reference for authoring XML modules. Everything here was read off a live **v1.4.8**
installation; treat the shapes as accurate for 1.4.x and re-verify on a major version bump.
Data-table locations in particular have moved between releases — in 1.4.x there is **no
single `spitems.xml`**; items were split into a directory.

## 1. Directory conventions

```
<game root>/
├── bin/Win64_Shipping_Client/        game binaries, TaleWorlds.*.dll
├── bin/Win64_Shipping_wEditor/       ONLY if Modding Kit installed
└── Modules/
    ├── Native/  SandBoxCore/  SandBox/  CustomBattle/  StoryMode/  Multiplayer/
    └── <YourMod>/
        ├── SubModule.xml             required
        └── ModuleData/
            ├── <table>.xml           XxxName path= in SubModule.xml
            ├── items/                per-category item tables (see §3)
            └── Languages/<locale>/   language_data.xml + string files
```

## 2. SubModule.xml

```xml
<?xml version='1.0' encoding='utf-8'?>
<Module>
  <Name value="Your Mod" />
  <Id value="YourMod" />
  <Version value="v1.0.0" />
  <ModuleCategory value="Singleplayer" />
  <SingleplayerModule value="true" />
  <MultiplayerModule value="false" />
  <DependedModules>
    <DependedModule Id="Native" />
    <DependedModule Id="SandBoxCore" />
    <DependedModule Id="SandBox" />
  </DependedModules>
  <SubModules />                        <!-- only for C# modules -->
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

Notes:

- `path` is the **basename under `ModuleData/`**, no extension. An undeclared table is never
  loaded — this is the most common reason a module appears to do nothing.
- `id` must match the loader's registered name for that data type (see §3), not an arbitrary
  string.
- `<ModuleType value="Official" />` appears only on TaleWorlds modules; omit it.
- `DependentVersion` is optional. Pinning it makes the module break on every game patch;
  omit unless a hard dependency truly exists.
- Version lives in `Modules/Native/SubModule.xml` as `<Version value = "v1.4.8"/>`. Note the
  spaces around `=` — a regex requiring `<Version value="` matches nothing.

## 3. Data table map (v1.4.8)

| Content | Module | Path under `ModuleData/` | XmlName id |
|---|---|---|---|
| Troops / NPCCharacters | SandBoxCore | `spnpccharacters.xml` | `NPCCharacters` |
| Templates | SandBoxCore | `spnpccharactertemplates.xml` | `NPCCharacters` |
| Obsolete characters | SandBoxCore | `obsolete_characters.xml` | `NPCCharacters` |
| Cultures, recruitment roots | SandBoxCore | `spcultures.xml` | `SPCultures` |
| Equipment set templates | SandBoxCore | `sandboxcore_equipment_sets.xml` | `EquipmentRosters` |
| Skill set templates | SandBoxCore | `sandboxcore_skill_sets.xml` | `SkillSets` |
| Body properties (face/body) | SandBoxCore | `sandboxcore_bodyproperties.xml` | `BodyProperties` |
| **Items (split by category)** | SandBoxCore | `items/` | `Items` |
| Combat parameters | Native | `combat_parameters.xml` | — |
| Campaign parameters | Native | `managed_campaign_parameters.xml` | — |
| Core parameters | Native | `managed_core_parameters.xml` | — |
| Native parameters | Native | `native_parameters.xml` | — |
| Skills, attributes | Native | `skills.xml`, `attributes.xml` | — |
| Scenes registry | Native | `scenes.xml` | — |

`items/` contains (1.4.8): `weapons.xml`, `head_armors.xml`, `body_armors.xml`,
`arm_armors.xml`, `leg_armors.xml`, `shoulder_armors.xml`, `shields.xml`,
`horses_and_others.xml`, `banners.xml`, `tournament_weapons.xml`.

**Item IDs are stored bare** in the item tables (`id="empire_sword_1_t2"` inside a
`<CraftedItem>` / `<Item>` element) and referenced with a type prefix
(`id="Item.empire_sword_1_t2"`). Grepping for `id="Item.` inside the item tables returns
nothing — a trap that looks like "the item doesn't exist".

## 4. Element schema: NPCCharacter (troop)

```xml
<NPCCharacter
    id="imperial_recruit"                 <!-- bare, no prefix -->
    default_group="Infantry"
    level="6"
    name="{=s3IJIFUw}Imperial Recruit"    <!-- {=key}English -->
    occupation="Soldier"
    is_basic_troop="true"                 <!-- only on culture recruitment roots -->
    culture="Culture.empire">
  <face>
    <face_key_template value="BodyProperty.fighter_empire" />
  </face>
  <skills>
    <skill id="Athletics" value="20" />
    <skill id="Riding" value="0" />
    <skill id="OneHanded" value="20" />
    <skill id="TwoHanded" value="10" />
    <skill id="Polearm" value="20" />
    <skill id="Bow" value="5" />
    <skill id="Crossbow" value="5" />
    <skill id="Throwing" value="10" />
  </skills>
  <upgrade_targets>
    <upgrade_target id="NPCCharacter.imperial_infantryman" />
    <upgrade_target id="NPCCharacter.imperial_archer" />
  </upgrade_targets>
  <Equipments>
    <EquipmentRoster>                     <!-- one variant; add several for variety -->
      <equipment slot="Item0" id="Item.peasant_pitchfork_2_t1" />
      <equipment slot="Item1" id="Item.battered_kite_shield" />
      <equipment slot="Item2" id="Item.imperial_throwing_spear_1_t4" />
      <equipment slot="Item3" id="Item.imperial_throwing_spear_1_t4_2" />
      <equipment slot="Head"  id="Item.arming_coif" />
      <equipment slot="Body"  id="Item.empire_warrior_padded_armor_a" />
      <equipment slot="Gloves" id="Item.buttoned_leather_bracers" />
      <equipment slot="Leg"   id="Item.empire_horseman_boots" />
      <equipment slot="Cape"  id="Item.imperial_studded_strip_shoulders" />
    </EquipmentRoster>
    <EquipmentSet id="empire_troop_civilian_template_t1" equipmentType="Civilian" />
  </Equipments>
</NPCCharacter>
```

- Empty terminal upgrade: `<upgrade_targets></upgrade_targets>`.
- Slots: `Item0`–`Item3` (weapons/shield/javelins), `Head`, `Body`, `Gloves`, `Leg`, `Cape`,
  `Horse`, `HorseHarness`.
- A **civilian** `EquipmentSet` is needed for troops that appear in civilian scenes; reuse
  the culture's `<culture>_troop_civilian_template_t<N>` IDs.
- **Cardinality**: vanilla troops carry at most **2** `upgrade_target` entries. Adding a 3rd
  is data-legal (the field is a list) but whether the upgrade screen renders it is
  unverified — flag it rather than asserting it works.
- `<skills>` values are integers; skill ids are the 18 vanilla skills (Athletics, Riding,
  OneHanded, TwoHanded, Polearm, Bow, Crossbow, Throwing, Smithing, Scouting, Tactics,
  Roguery, Charm, Leadership, Trade, Steward, Medicine, Engineering).
- Some troops use `skill_template="SkillSet.xxx"` instead of inline `<skills>`.

## 5. Element schema: Culture (recruitment roots)

`spcultures.xml` → `<Culture id="empire" ...>` with the recruitment-relevant attributes:

```
basic_troop="NPCCharacter.imperial_recruit"
elite_basic_troop="NPCCharacter.imperial_vigla_recruit"
melee_militia_troop="NPCCharacter.imperial_militia_spearman"
ranged_militia_troop="NPCCharacter.imperial_militia_archer"
melee_elite_militia_troop="NPCCharacter.imperial_militia_veteran_spearman"
ranged_elite_militia_troop="NPCCharacter.imperial_militia_veteran_archer"
```

These are **single-valued**. Overriding a culture to point at a custom troop therefore
*removes* the vanilla troop from recruitment. That is a destructive override — surface the
trade-off explicitly. Where a custom troop only needs to be reachable, prefer attaching it as
an extra `upgrade_target` on an existing troop instead.

Also present: `villager_party_template`, `default_party_template`,
`militia_party_template`, `rebels_party_template`, `settlement_patrol_template_level_1..3`,
`prosperity_bonus`, and dozens of `NPCCharacter.*` role references (villager, guard,
blacksmith, tavernkeeper, …). Children include `<caravan_party_templates>`,
`<elite_caravan_party_templates>`, `<vassal_reward_items>`,
`<banner_bearer_replacement_weapons>`, `<default_policies>`, `<male_names>`, `<female_names>`.

## 6. Localization mechanics

`name="{=s3IJIFUw}Imperial Recruit"` — the `{=...}` payload is a string key resolved against
the loaded language files; on miss the game falls back to the English text after the brace.
Keys are conventionally 8 alphanumeric characters; matching that shape avoids parser
surprises.

Per-module layout, mirrored by every official module and by third-party mods:

```
ModuleData/Languages/CNs/language_data.xml
ModuleData/Languages/CNs/std_<whatever>-zho-CN.xml
```

`language_data.xml` (UTF-16, BOM):

```xml
<?xml version="1.0" encoding="utf-16"?>
<LanguageData id="简体中文">
  <LanguageFile xml_path="CNs/std_yourmod-zho-CN.xml" />
</LanguageData>
```

String file (UTF-16, BOM):

```xml
<?xml version="1.0" encoding="utf-16"?>
<base xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xmlns:xsd="http://www.w3.org/2001/XMLSchema" type="string">
 <tags>
  <tag language="简体中文"/>
 </tags>
 <strings>
  <string id="HgGuard1" text="家兵新兵" />
 </strings>
</base>
```

`xml_path` is relative to the `Languages/` directory, i.e. `"<locale>/<file>"`.

**Encoding is not cosmetic.** Official modules use **UTF-8 with BOM** for `SubModule.xml`
and data tables, and **UTF-16 LE with BOM** (`FF FE`) for everything under `Languages/`.
Write those exact encodings.

## 7. Load order and override semantics

The object manager registers objects under string IDs. Modules load in dependency order;
**objects from a later-loading module override same-ID objects from earlier ones, and
objects with distinct IDs coexist.**

Consequences that drive module design:

1. A patch module ships **only** the objects it adds or overrides. Copying a whole vanilla
   table into your module is a bug — it is unnecessary, bloats the download, and freezes
   vanilla content at whatever version you copied.
2. To modify one field of a vanilla object you re-declare that whole object. There is no
   field-level merge. Therefore **extract the vanilla element byte-exact and edit only the
   target field** — hand-transcribing a 100-line element is how typos enter item IDs.
3. Removal is lossless: deleting the module folder restores vanilla behaviour, except for
   save-game references to removed custom objects.

### XSLT — the field-level channel (the exception to point 2)

"No field-level merge" describes plain data-table XML only. Official v1.4.8 content ships a **second,
field-level** channel, declared through the **same** `<Xmls>` block:

| Channel | Granularity | Declaration |
|---|---|---|
| Plain data-table XML | whole-node same-ID override | `<XmlName id="SPCultures" path="naval_cultures"/>` |
| **XSLT transform** | **field-level**: locate an element by ID, replace individual attributes | `<XmlName id="SPCultures" path="XSLT/NavalDLC_SandBoxCore_SPCultures"/>` |

Official `NavalDLC` — an official module, `ModuleType=OfficialOptional` — ships five `.xslt` files under
`ModuleData/XSLT/` that transform **other modules'** tables (`Native`, `SandBoxCore`, `Sandbox`,
`StoryMode`). The only difference from an ordinary table declaration is that `path` points into the `XSLT/`
subdirectory; `id` is still the **target table type**, not a new table. Naming:
`<owner>_<sourceModule>_<table>.xslt`.

## 8. Iteration loop

1. `scripts/probe_game.py` → root, version, Modding Kit presence, module + table inventory.
2. Read the real vanilla element you intend to override, plus a sibling element of similar
   tier/culture to use as a template for new content.
3. `scripts/scaffold_module.py extract` → byte-exact block; edit minimally.
4. `scripts/scaffold_module.py new` → module skeleton with correct encodings.
5. `scripts/validate_refs.py` → cross-table ID check. **An empty reference set means the
   extraction regex is wrong, not that everything is fine.**
6. Copy the module into `Modules/`, enable it in the launcher (BLSE if present), and verify
   in game. Report static verification and in-game verification as separate claims.
