// Package gameplay mirrors the ten gameplay "getter" tools and their get_entity dispatcher:
// src/tools/get-{entity,hero-profile,skill-data,culture-summary,clan-summary,kingdom-summary,
// policy-summary,perk-data,item-stats,settlement-summary}.ts
//
// ── THE THREE SHAPES THAT REPEAT, and each of which a plausible port gets wrong ────────────
//
//  1. NULL IS NOT ZERO AND NOT EMPTY. Every field is a report.Scalar, so a NULL column renders
//     as "unknown" while a real 0 renders as "0" and an empty string renders as "unknown". That
//     is why the scans use sql.NullString/NullFloat64/NullInt64 rather than the bare types: the
//     distinction is visible in the output.
//
//  2. JAVASCRIPT FALSINESS. `row.shortName ? resolve(...) : null` treats an EMPTY STRING as
//     absent, so an empty short name renders as "unknown" rather than as nothing. Same for
//     `row.isNoble ? 'true' : 'false'` where a NULL (possible via LEFT JOIN) is falsy.
//
//  3. RAW REFERENCES SIT BESIDE RESOLVED ONES. `culture_ref: row.troopCulture` in the hero
//     profile is the raw column, while the clan summary's `culture_ref` goes through
//     FormatReferenceLabel. The two look identical in output and are computed differently;
//     unifying them would change the text.
package gameplay

import (
	"database/sql"
	"encoding/json"
	"strings"

	"blore/internal/entityresolver"
	"blore/internal/localization"
	"blore/internal/policyid"
	"blore/internal/report"
)

// ── scalar helpers ──────────────────────────────────────────────────────────

// textScalar renders a nullable text column: NULL -> unknown.
func textScalar(v sql.NullString) report.Scalar {
	if !v.Valid {
		return report.Null()
	}
	return report.Text(v.String)
}

// textFalsy mirrors JavaScript truthiness on a text column, so an EMPTY string is treated as
// absent exactly as `row.shortName ? ... : null` does.
func textFalsy(v sql.NullString) report.Scalar {
	if !v.Valid || v.String == "" {
		return report.Null()
	}
	return report.Text(v.String)
}

// numScalar renders a nullable numeric column.
func numScalar(v sql.NullFloat64) report.Scalar {
	if !v.Valid {
		return report.Null()
	}
	return report.Number(v.Float64)
}

// numFromInt renders a nullable integer column.
func numFromInt(v sql.NullInt64) report.Scalar {
	if !v.Valid {
		return report.Null()
	}
	return report.Number(float64(v.Int64))
}

// jsTruthy reports JavaScript truthiness for a nullable integer: NULL and 0 are falsy.
func jsTruthy(v sql.NullInt64) bool {
	return v.Valid && v.Int64 != 0
}

// boolText mirrors `cond ? 'true' : 'false'`.
func boolText(cond bool) report.Scalar {
	if cond {
		return report.Text("true")
	}
	return report.Text("false")
}

// yesNo mirrors toYesNo: `Number(value) ? 'yes' : 'no'`, so NULL and 0 are 'no'.
func yesNo(v sql.NullInt64) report.Scalar {
	if jsTruthy(v) {
		return report.Text("yes")
	}
	return report.Text("no")
}

// formatAlive mirrors formatAlive: a falsy value means alive, and only the literal string
// "false" (case-insensitively) means dead. Note that an unexpected value such as "0" counts as
// ALIVE — the function tests for one specific string, not for falsehood.
func formatAlive(value sql.NullString) report.Scalar {
	if !value.Valid || value.String == "" {
		return report.Text("yes")
	}
	if strings.EqualFold(value.String, "false") {
		return report.Text("no")
	}
	return report.Text("yes")
}

// localizeText mirrors `resolveMaybeLocalizedText(x)` with an unknown (NULL/empty) input
// rendering as "unknown".
func localizeText(db *sql.DB, v sql.NullString, preferred []string) (report.Scalar, error) {
	resolved, err := localization.ResolveMaybeLocalizedText(db, v.String, preferred)
	if err != nil {
		return report.Absent(), err
	}
	return report.Text(resolved), nil
}

// localizeFalsy mirrors `row.x ? resolveMaybeLocalizedText(row.x) : null`.
func localizeFalsy(db *sql.DB, v sql.NullString, preferred []string) (report.Scalar, error) {
	if !v.Valid || v.String == "" {
		return report.Null(), nil
	}
	return localizeText(db, v, preferred)
}

// parseIDList mirrors parseIdList: JSON parse, keep only string elements, and any failure yields
// an EMPTY list. A non-array JSON value also yields an empty list.
func parseIDList(raw string) []string {
	var parsed any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil
	}
	arr, ok := parsed.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// referenceBlock is a reusable list field naming the resolved reference labels.
func referenceLabels(db *sql.DB, ids []string, resolve func(string) (string, bool, error), preferred []string) ([]report.Scalar, error) {
	values := make([]report.Scalar, 0, len(ids))
	for _, id := range ids {
		name, _, err := resolve(id)
		if err != nil {
			return nil, err
		}
		// ★ the resolver's "found" flag is deliberately dropped: formatReferenceLabel decides on the
		// VALUE (empty means absent), not on whether a row existed.
		label, err := entityresolver.FormatReferenceLabel(db, id, name, preferred)
		if err != nil {
			return nil, err
		}
		values = append(values, report.Text(label))
	}
	return values, nil
}

// GetEntity mirrors getEntity(kind, id) and its kind dispatch.
func GetEntity(db *sql.DB, kind, id string, preferred []string) (string, error) {
	switch kind {
	case "clan":
		return GetClanSummary(db, id, preferred)
	case "culture":
		return GetCultureSummary(db, id, preferred)
	case "hero":
		return GetHeroProfile(db, id, preferred)
	case "item":
		return GetItemStats(db, id, preferred)
	case "kingdom":
		return GetKingdomSummary(db, id, preferred)
	case "perk":
		return GetPerkData(db, id, preferred)
	case "policy":
		return GetPolicySummary(db, id, preferred)
	case "settlement":
		return GetSettlementSummary(db, id, preferred)
	case "skill":
		return GetSkillData(db, id, preferred)
	case "troop":
		return TraceTroopTree(db, id, preferred)
	}
	return "", &UnknownKindError{Kind: kind}
}

// UnknownKindError is returned for a kind outside GAMEPLAY_ENTITY_KINDS. The TypeScript has no
// default case, so it would return undefined and the caller would fail on `.content`; an explicit
// error is friendlier and cannot be mistaken for a successful empty result.
type UnknownKindError struct{ Kind string }

func (e *UnknownKindError) Error() string { return "unknown gameplay entity kind: " + e.Kind }

// ── hero profile ────────────────────────────────────────────────────────────

func GetHeroProfile(db *sql.DB, heroID string, preferred []string) (string, error) {
	rows, err := db.Query(`
		SELECT
			h.heroId, h.filePath, h.faction, h.clan, h.spouse, h.father, h.mother,
			h.alive, h.isTemplate, h.text,
			t.name AS troopName, t.culture AS troopCulture, t.occupation AS troopOccupation,
			t.skillTemplate AS troopSkillTemplate, t.isFemale AS troopIsFemale
		FROM bannerlord_heroes h
		LEFT JOIN bannerlord_troops t
			ON t.characterId = h.heroId
		WHERE h.heroId = ?
		ORDER BY h.filePath, t.filePath`, heroID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type row struct {
		heroID, filePath, faction, clan, spouse, father, mother sql.NullString
		alive, text                                             sql.NullString
		isTemplate                                              sql.NullInt64
		troopName, troopCulture, troopOccupation, skillTemplate sql.NullString
		troopIsFemale                                           sql.NullInt64
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.heroID, &r.filePath, &r.faction, &r.clan, &r.spouse, &r.father,
			&r.mother, &r.alive, &r.isTemplate, &r.text, &r.troopName, &r.troopCulture,
			&r.troopOccupation, &r.skillTemplate, &r.troopIsFemale); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "Hero not found: " + heroID, nil
	}

	blocks := make([]report.Block, 0, len(all))
	for i, r := range all {
		displayName, err := localizeText(db, r.troopName, preferred)
		if err != nil {
			return "", err
		}
		biography, err := localizeFalsy(db, r.text, preferred)
		if err != nil {
			return "", err
		}

		gender := report.Text("male_or_unspecified")
		if jsTruthy(r.troopIsFemale) {
			gender = report.Text("female")
		}

		blocks = append(blocks, report.Block{
			Header: "hero_" + report.Itoa(i+1),
			Fields: []report.Field{
				{Key: "source_path", Value: textScalar(r.filePath)},
				{Key: "hero_id", Value: textScalar(r.heroID)},
				{Key: "display_name", Value: displayName},
				{Key: "faction_ref", Value: textScalar(r.faction)},
				{Key: "clan_ref", Value: textScalar(r.clan)},
				// ★ RAW, not resolved: the hero profile does NOT look the culture up.
				{Key: "culture_ref", Value: textScalar(r.troopCulture)},
				{Key: "occupation", Value: textScalar(r.troopOccupation)},
				{Key: "alive", Value: formatAlive(r.alive)},
				{Key: "is_template", Value: boolText(jsTruthy(r.isTemplate))},
				{Key: "gender", Value: gender},
				{Key: "skill_template", Value: textScalar(r.skillTemplate)},
				{Key: "spouse_ref", Value: textScalar(r.spouse)},
				{Key: "father_ref", Value: textScalar(r.father)},
				{Key: "mother_ref", Value: textScalar(r.mother)},
			},
			MultilineFields: []report.Field{{Key: "biography", Value: biography}},
		})
	}
	return report.Render("hero_profile", "query_hero_id", heroID, blocks, nil), nil
}

// ── skill data ──────────────────────────────────────────────────────────────

type skillModifier struct {
	AttribCode   *string `json:"attribCode"`
	Modification *string `json:"modification"`
	Value        *string `json:"value"`
}

// parseModifiers mirrors parseModifiers: any parse failure, or a non-array value, yields an
// EMPTY slice rather than an error.
func parseModifiers(raw string) []skillModifier {
	var parsed []skillModifier
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil
	}
	return parsed
}

// modifierLabel mirrors the template string, where a null OR empty field becomes "unknown".
func modifierLabel(m skillModifier) string {
	field := func(p *string) string {
		if p == nil || *p == "" {
			return "unknown"
		}
		return *p
	}
	return "attrib_code=" + field(m.AttribCode) + " | modification=" + field(m.Modification) +
		" | value=" + field(m.Value)
}

func GetSkillData(db *sql.DB, skillID string, preferred []string) (string, error) {
	rows, err := db.Query(`
		SELECT skillId, filePath, name, documentation, modifierCount, modifiersJson
		FROM bannerlord_skills
		WHERE skillId = ?
		ORDER BY filePath`, skillID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type row struct {
		skillID, filePath, name, documentation, modifiersJSON sql.NullString
		modifierCount                                         sql.NullInt64
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.skillID, &r.filePath, &r.name, &r.documentation,
			&r.modifierCount, &r.modifiersJSON); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "Skill data not found: " + skillID, nil
	}

	blocks := make([]report.Block, 0, len(all))
	for i, r := range all {
		// ★ The list is built from modifiersJson, NOT from modifierCount. The two can disagree
		// (the crafted corpus has modifierCount 9 with unparseable JSON, yielding an empty list),
		// and the tool reports both: the count as a field, the list from the JSON.
		modifiers := parseModifiers(r.modifiersJSON.String)
		values := make([]report.Scalar, 0, len(modifiers))
		for _, m := range modifiers {
			values = append(values, report.Text(modifierLabel(m)))
		}

		blocks = append(blocks, report.Block{
			Header: "skill_" + report.Itoa(i+1),
			Fields: []report.Field{
				{Key: "source_path", Value: textScalar(r.filePath)},
				{Key: "skill_id", Value: textScalar(r.skillID)},
				// ★ RAW: no localization call here, unlike most other display_name fields.
				{Key: "display_name", Value: textScalar(r.name)},
				{Key: "modifier_count", Value: numFromInt(r.modifierCount)},
			},
			ListFields:      []report.ListField{{Key: "modifiers", Values: values}},
			MultilineFields: []report.Field{{Key: "documentation", Value: textScalar(r.documentation)}},
		})
	}
	return report.Render("skill_data", "query_skill_id", skillID, blocks, nil), nil
}

// ── culture summary ─────────────────────────────────────────────────────────

func GetCultureSummary(db *sql.DB, cultureID string, preferred []string) (string, error) {
	rows, err := db.Query(`
		SELECT cultureId, filePath, name, descriptionText, isMainCulture, color, color2,
		       basicTroop, eliteBasicTroop, canHaveSettlement, boardGameType,
		       maleNameCount, femaleNameCount, defaultPolicyIdsJson, defaultPolicyCount
		FROM bannerlord_cultures
		WHERE cultureId = ?`+cultureOrderSQL, cultureID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type row struct {
		cultureID, filePath, name, description, color, color2         sql.NullString
		basicTroop, eliteBasicTroop, canHaveSettlement, boardGameType sql.NullString
		defaultPolicyIDsJSON                                          sql.NullString
		isMainCulture                                                 sql.NullInt64
		maleNameCount, femaleNameCount, defaultPolicyCount            sql.NullInt64
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.cultureID, &r.filePath, &r.name, &r.description, &r.isMainCulture,
			&r.color, &r.color2, &r.basicTroop, &r.eliteBasicTroop, &r.canHaveSettlement,
			&r.boardGameType, &r.maleNameCount, &r.femaleNameCount, &r.defaultPolicyIDsJSON,
			&r.defaultPolicyCount); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "Culture not found: " + cultureID, nil
	}

	blocks := make([]report.Block, 0, len(all))
	for i, r := range all {
		displayName, err := localizeText(db, r.name, preferred)
		if err != nil {
			return "", err
		}
		description, err := localizeFalsy(db, r.description, preferred)
		if err != nil {
			return "", err
		}
		policies, err := referenceLabels(db, parseIDList(r.defaultPolicyIDsJSON.String),
			func(id string) (string, bool, error) { return entityresolver.LookupPolicyName(db, id) }, preferred)
		if err != nil {
			return "", err
		}

		blocks = append(blocks, report.Block{
			Header: "culture_" + report.Itoa(i+1),
			Fields: []report.Field{
				{Key: "source_path", Value: textScalar(r.filePath)},
				{Key: "culture_id", Value: textScalar(r.cultureID)},
				{Key: "display_name", Value: displayName},
				{Key: "is_main_culture", Value: boolText(jsTruthy(r.isMainCulture))},
				// ★ RAW, not wrapped in a truthiness test: NULL -> unknown, empty -> unknown.
				{Key: "can_have_settlement", Value: textScalar(r.canHaveSettlement)},
				{Key: "color_primary", Value: textScalar(r.color)},
				{Key: "color_secondary", Value: textScalar(r.color2)},
				{Key: "basic_troop_ref", Value: textScalar(r.basicTroop)},
				{Key: "elite_basic_troop_ref", Value: textScalar(r.eliteBasicTroop)},
				{Key: "board_game_type", Value: textScalar(r.boardGameType)},
				{Key: "male_name_count", Value: numFromInt(r.maleNameCount)},
				{Key: "female_name_count", Value: numFromInt(r.femaleNameCount)},
				{Key: "default_policy_count", Value: numFromInt(r.defaultPolicyCount)},
			},
			ListFields:      []report.ListField{{Key: "default_policy_refs", Values: policies}},
			MultilineFields: []report.Field{{Key: "description", Value: description}},
		})
	}
	return report.Render("culture_summary", "query_culture_id", cultureID, blocks, nil), nil
}

// cultureOrderSQL mirrors the ORDER BY shared by the culture summary and the culture lookup. It
// must stay identical to entityresolver's, or the same id would pick different rows depending on
// which tool asked.
const cultureOrderSQL = `
	ORDER BY
		(maleNameCount + femaleNameCount) DESC,
		CASE WHEN descriptionText IS NOT NULL AND descriptionText <> '' THEN 0 ELSE 1 END,
		filePath`

// ── clan summary ────────────────────────────────────────────────────────────

func describeClanKind(clanID string, isNoble, isMinorFaction, isMercenary, isBandit bool) string {
	switch {
	case isNoble:
		return "noble clan"
	case isMinorFaction:
		if isMercenary {
			return "minor mercenary faction"
		}
		return "minor faction"
	case isBandit:
		return "bandit faction"
	case clanID == "player_faction":
		return "player faction"
	default:
		return "faction"
	}
}

func GetClanSummary(db *sql.DB, clanID string, preferred []string) (string, error) {
	rows, err := db.Query(`
		SELECT clanId, filePath, name, shortName, descriptionText, culture, owner,
		       initialHomeSettlement, superFaction, tier, isNoble, isMinorFaction, isBandit,
		       isOutlaw, isMafia, isMercenary, color, color2, templateCount
		FROM bannerlord_clans
		WHERE clanId = ?
		ORDER BY
			CASE WHEN isNoble = 1 THEN 0 WHEN isMinorFaction = 1 THEN 1 ELSE 2 END,
			filePath`, clanID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type row struct {
		clanID, filePath, name, shortName, description       sql.NullString
		culture, owner, homeSettlement, superFaction         sql.NullString
		color, color2                                        sql.NullString
		tier                                                 sql.NullInt64
		isNoble, isMinorFaction, isBandit, isOutlaw, isMafia sql.NullInt64
		isMercenary, templateCount                           sql.NullInt64
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.clanID, &r.filePath, &r.name, &r.shortName, &r.description,
			&r.culture, &r.owner, &r.homeSettlement, &r.superFaction, &r.tier, &r.isNoble,
			&r.isMinorFaction, &r.isBandit, &r.isOutlaw, &r.isMafia, &r.isMercenary, &r.color,
			&r.color2, &r.templateCount); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "Clan or faction not found: " + clanID, nil
	}

	blocks := make([]report.Block, 0, len(all))
	for i, r := range all {
		displayName, err := localizeText(db, r.name, preferred)
		if err != nil {
			return "", err
		}
		shortName, err := localizeFalsy(db, r.shortName, preferred)
		if err != nil {
			return "", err
		}
		description, err := localizeFalsy(db, r.description, preferred)
		if err != nil {
			return "", err
		}

		cultureName, _, err := entityresolver.LookupCultureName(db, r.culture.String)
		if err != nil {
			return "", err
		}
		cultureRef, err := entityresolver.FormatReferenceLabel(db, r.culture.String, cultureName, preferred)
		if err != nil {
			return "", err
		}

		ownerName, _, err := entityresolver.LookupHeroName(db, r.owner.String)
		if err != nil {
			return "", err
		}
		ownerRef, err := entityresolver.FormatReferenceLabel(db, r.owner.String, ownerName, preferred)
		if err != nil {
			return "", err
		}

		homeInfo, err := entityresolver.LookupSettlementInfo(db, r.homeSettlement.String)
		if err != nil {
			return "", err
		}
		homeRef, err := formatSettlementRef(db, r.homeSettlement.String, homeInfo, preferred)
		if err != nil {
			return "", err
		}

		// ★ THIS CONDITION IS NOT LIKE ITS NEIGHBOURS. The super-faction label is computed only
		// when the raw reference OR the looked-up name is present; every other reference in this
		// block is computed unconditionally from the raw value. A port that always called
		// FormatReferenceLabel here would emit "unknown" where the original emits null.
		superInfo, err := entityresolver.LookupKingdomInfo(db, r.superFaction.String)
		if err != nil {
			return "", err
		}
		var superRef report.Scalar
		if r.superFaction.String != "" || (superInfo != nil && superInfo.Name != "") {
			superName := ""
			if superInfo != nil {
				superName = superInfo.Name
			}
			label, err := entityresolver.FormatReferenceLabel(db, r.superFaction.String, superName, preferred)
			if err != nil {
				return "", err
			}
			superRef = report.Text(label)
		} else {
			superRef = report.Null()
		}

		blocks = append(blocks, report.Block{
			Header: "clan_" + report.Itoa(i+1),
			Fields: []report.Field{
				{Key: "source_path", Value: textScalar(r.filePath)},
				{Key: "clan_id", Value: textScalar(r.clanID)},
				{Key: "display_name", Value: displayName},
				{Key: "short_name", Value: shortName},
				{Key: "kind", Value: report.Text(describeClanKind(r.clanID.String,
					jsTruthy(r.isNoble), jsTruthy(r.isMinorFaction), jsTruthy(r.isMercenary),
					jsTruthy(r.isBandit)))},
				{Key: "culture_ref", Value: report.Text(cultureRef)},
				{Key: "owner_hero_ref", Value: report.Text(ownerRef)},
				{Key: "home_settlement_ref", Value: homeRef},
				{Key: "super_faction_ref", Value: superRef},
				{Key: "tier", Value: numFromInt(r.tier)},
				{Key: "color_primary", Value: textScalar(r.color)},
				{Key: "color_secondary", Value: textScalar(r.color2)},
				{Key: "template_count", Value: numFromInt(r.templateCount)},
				{Key: "flag_is_noble", Value: yesNo(r.isNoble)},
				{Key: "flag_is_minor_faction", Value: yesNo(r.isMinorFaction)},
				{Key: "flag_is_bandit", Value: yesNo(r.isBandit)},
				{Key: "flag_is_outlaw", Value: yesNo(r.isOutlaw)},
				{Key: "flag_is_mafia", Value: yesNo(r.isMafia)},
				{Key: "flag_is_mercenary", Value: yesNo(r.isMercenary)},
			},
			MultilineFields: []report.Field{{Key: "description", Value: description}},
		})
	}
	return report.Render("clan_summary", "query_clan_id", clanID, blocks, nil), nil
}

// formatSettlementRef mirrors the settlement-reference pattern:
// `raw || name ? formatReferenceLabel(raw, name) : null`.
func formatSettlementRef(db *sql.DB, raw string, info *entityresolver.SettlementInfo, preferred []string) (report.Scalar, error) {
	name := ""
	if info != nil {
		name = info.Name
	}
	// The guard is the same truthiness test formatReferenceLabel applies internally, written out
	// here because this call site must produce a NULL rather than a label when both sides are blank.
	if raw == "" && name == "" {
		return report.Null(), nil
	}
	label, err := entityresolver.FormatReferenceLabel(db, raw, name, preferred)
	if err != nil {
		return report.Null(), err
	}
	return report.Text(label), nil
}

// ── kingdom summary ─────────────────────────────────────────────────────────

func GetKingdomSummary(db *sql.DB, kingdomID string, preferred []string) (string, error) {
	rows, err := db.Query(`
		SELECT kingdomId, filePath, name, shortName, title, rulerTitle, descriptionText,
		       culture, owner, initialHomeSettlement, color, color2, primaryBannerColor,
		       secondaryBannerColor, relationshipCount, policyCount, policyIdsJson
		FROM bannerlord_kingdoms
		WHERE kingdomId = ?
		ORDER BY filePath`, kingdomID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type row struct {
		kingdomID, filePath, name, shortName, title, rulerTitle, description sql.NullString
		culture, owner, homeSettlement                                       sql.NullString
		color, color2, bannerColor1, bannerColor2                            sql.NullString
		policyIDsJSON                                                        sql.NullString
		relationshipCount, policyCount                                       sql.NullInt64
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.kingdomID, &r.filePath, &r.name, &r.shortName, &r.title,
			&r.rulerTitle, &r.description, &r.culture, &r.owner, &r.homeSettlement, &r.color,
			&r.color2, &r.bannerColor1, &r.bannerColor2, &r.relationshipCount, &r.policyCount,
			&r.policyIDsJSON); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "Kingdom not found: " + kingdomID, nil
	}

	blocks := make([]report.Block, 0, len(all))
	for i, r := range all {
		displayName, err := localizeText(db, r.name, preferred)
		if err != nil {
			return "", err
		}
		shortName, err := localizeFalsy(db, r.shortName, preferred)
		if err != nil {
			return "", err
		}
		title, err := localizeFalsy(db, r.title, preferred)
		if err != nil {
			return "", err
		}
		rulerTitle, err := localizeFalsy(db, r.rulerTitle, preferred)
		if err != nil {
			return "", err
		}
		description, err := localizeFalsy(db, r.description, preferred)
		if err != nil {
			return "", err
		}

		cultureName, _, err := entityresolver.LookupCultureName(db, r.culture.String)
		if err != nil {
			return "", err
		}
		cultureRef, err := entityresolver.FormatReferenceLabel(db, r.culture.String, cultureName, preferred)
		if err != nil {
			return "", err
		}

		ownerName, _, err := entityresolver.LookupHeroName(db, r.owner.String)
		if err != nil {
			return "", err
		}
		ownerRef, err := entityresolver.FormatReferenceLabel(db, r.owner.String, ownerName, preferred)
		if err != nil {
			return "", err
		}

		homeInfo, err := entityresolver.LookupSettlementInfo(db, r.homeSettlement.String)
		if err != nil {
			return "", err
		}
		homeRef, err := formatSettlementRef(db, r.homeSettlement.String, homeInfo, preferred)
		if err != nil {
			return "", err
		}

		policies, err := referenceLabels(db, parseIDList(r.policyIDsJSON.String),
			func(id string) (string, bool, error) { return entityresolver.LookupPolicyName(db, id) }, preferred)
		if err != nil {
			return "", err
		}

		blocks = append(blocks, report.Block{
			Header: "kingdom_" + report.Itoa(i+1),
			Fields: []report.Field{
				{Key: "source_path", Value: textScalar(r.filePath)},
				{Key: "kingdom_id", Value: textScalar(r.kingdomID)},
				{Key: "display_name", Value: displayName},
				{Key: "short_name", Value: shortName},
				{Key: "title", Value: title},
				{Key: "ruler_title", Value: rulerTitle},
				{Key: "culture_ref", Value: report.Text(cultureRef)},
				{Key: "owner_hero_ref", Value: report.Text(ownerRef)},
				{Key: "home_settlement_ref", Value: homeRef},
				{Key: "color_primary", Value: textScalar(r.color)},
				{Key: "color_secondary", Value: textScalar(r.color2)},
				{Key: "banner_color_primary", Value: textScalar(r.bannerColor1)},
				{Key: "banner_color_secondary", Value: textScalar(r.bannerColor2)},
				{Key: "relationship_count", Value: numFromInt(r.relationshipCount)},
				{Key: "policy_count", Value: numFromInt(r.policyCount)},
			},
			ListFields:      []report.ListField{{Key: "active_policy_refs", Values: policies}},
			MultilineFields: []report.Field{{Key: "description", Value: description}},
		})
	}
	return report.Render("kingdom_summary", "query_kingdom_id", kingdomID, blocks, nil), nil
}

// ── policy summary ──────────────────────────────────────────────────────────

func GetPolicySummary(db *sql.DB, policyID string, preferred []string) (string, error) {
	// ★ THE FALLBACK IS NOT COSMETIC. `normalizeBannerlordPolicyId(policyId) ?? policyId` keeps
	// the ORIGINAL string when normalisation yields nothing, so a query of "Policy." is looked up
	// as the literal "Policy." rather than as an empty id.
	normalized, ok := policyid.Normalize(policyID)
	if !ok {
		normalized = policyID
	}

	rows, err := db.Query(`
		SELECT policyId, rawPolicyId, filePath, sourceModule, displayName, descriptionText,
		       proposalText, effectsText, rulerSupport, lordsSupport, commonsSupport,
		       activeKingdomIdsJson, defaultCultureIdsJson, activeKingdomCount, defaultCultureCount
		FROM bannerlord_policies
		WHERE policyId = ?
		LIMIT 1`, normalized)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type row struct {
		policyID, rawPolicyID, filePath, sourceModule, displayName sql.NullString
		description, proposal, effects                             sql.NullString
		activeKingdomIDsJSON, defaultCultureIDsJSON                sql.NullString
		rulerSupport, lordsSupport, commonsSupport                 sql.NullInt64
		activeKingdomCount, defaultCultureCount                    sql.NullInt64
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.policyID, &r.rawPolicyID, &r.filePath, &r.sourceModule,
			&r.displayName, &r.description, &r.proposal, &r.effects, &r.rulerSupport,
			&r.lordsSupport, &r.commonsSupport, &r.activeKingdomIDsJSON,
			&r.defaultCultureIDsJSON, &r.activeKingdomCount, &r.defaultCultureCount); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "Policy not found: " + policyID, nil
	}

	blocks := make([]report.Block, 0, len(all))
	for i, r := range all {
		displayName, err := localizeFalsy(db, r.displayName, preferred)
		if err != nil {
			return "", err
		}
		description, err := localizeFalsy(db, r.description, preferred)
		if err != nil {
			return "", err
		}
		proposal, err := localizeFalsy(db, r.proposal, preferred)
		if err != nil {
			return "", err
		}
		effects, err := localizeFalsy(db, r.effects, preferred)
		if err != nil {
			return "", err
		}

		kingdoms, err := referenceLabels(db, parseIDList(r.activeKingdomIDsJSON.String),
			func(id string) (string, bool, error) {
				info, err := entityresolver.LookupKingdomInfo(db, id)
				if err != nil || info == nil {
					return "", false, err
				}
				return info.Name, true, nil
			}, preferred)
		if err != nil {
			return "", err
		}
		cultures, err := referenceLabels(db, parseIDList(r.defaultCultureIDsJSON.String),
			func(id string) (string, bool, error) { return entityresolver.LookupCultureName(db, id) }, preferred)
		if err != nil {
			return "", err
		}

		blocks = append(blocks, report.Block{
			Header: "policy_" + report.Itoa(i+1),
			Fields: []report.Field{
				{Key: "source_path", Value: textScalar(r.filePath)},
				{Key: "policy_id", Value: textScalar(r.policyID)},
				{Key: "source_object_id", Value: textScalar(r.rawPolicyID)},
				{Key: "source_module", Value: textScalar(r.sourceModule)},
				{Key: "display_name", Value: displayName},
				{Key: "ruler_support", Value: numFromInt(r.rulerSupport)},
				{Key: "lords_support", Value: numFromInt(r.lordsSupport)},
				{Key: "commons_support", Value: numFromInt(r.commonsSupport)},
				{Key: "active_kingdom_count", Value: numFromInt(r.activeKingdomCount)},
				{Key: "default_culture_count", Value: numFromInt(r.defaultCultureCount)},
			},
			ListFields: []report.ListField{
				{Key: "active_kingdom_refs", Values: kingdoms},
				{Key: "default_culture_refs", Values: cultures},
			},
			MultilineFields: []report.Field{
				{Key: "description", Value: description},
				{Key: "proposal_text", Value: proposal},
				{Key: "effect_summary", Value: effects},
			},
		})
	}
	// ★ The ONLY getter with a top field, and it reports the NORMALISED id, which may differ from
	// the query text — so the query echoes what the caller asked for and this says what was used.
	topFields := []report.Field{{Key: "normalized_policy_id", Value: report.Text(normalized)}}
	return report.Render("policy_summary", "query_policy_id", policyID, blocks, topFields), nil
}

// ── perk data ───────────────────────────────────────────────────────────────

func lookupPerkName(db *sql.DB, perkID string) (string, bool, error) {
	if perkID == "" {
		return "", false, nil
	}
	var name sql.NullString
	err := db.QueryRow(`SELECT displayName FROM bannerlord_perks WHERE perkId = ? LIMIT 1`, perkID).Scan(&name)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !name.Valid {
		return "", false, nil
	}
	return name.String, true, nil
}

func GetPerkData(db *sql.DB, perkID string, preferred []string) (string, error) {
	rows, err := db.Query(`
		SELECT perkId, filePath, sourceModule, skillId, tierIndex, requiredSkillValue,
		       alternativePerkId, displayName, primaryDescription, primaryRole, primaryBonus,
		       primaryIncrementType, primaryTroopUsageMask, secondaryDescription, secondaryRole,
		       secondaryBonus, secondaryIncrementType, secondaryTroopUsageMask, sourceOrder
		FROM bannerlord_perks
		WHERE perkId = ? OR lower(perkId) = lower(?)
		ORDER BY sourceOrder`, perkID, perkID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type row struct {
		perkID, filePath, sourceModule, skillID, alternativePerkID          sql.NullString
		displayName, primaryDesc, primaryRole, primaryIncrementType         sql.NullString
		secondaryDesc, secondaryRole, secondaryIncrementType                sql.NullString
		tierIndex, requiredSkillValue, primaryTroopMask, secondaryTroopMask sql.NullInt64
		sourceOrder                                                         sql.NullInt64
		primaryBonus, secondaryBonus                                        sql.NullFloat64
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.perkID, &r.filePath, &r.sourceModule, &r.skillID, &r.tierIndex,
			&r.requiredSkillValue, &r.alternativePerkID, &r.displayName, &r.primaryDesc,
			&r.primaryRole, &r.primaryBonus, &r.primaryIncrementType, &r.primaryTroopMask,
			&r.secondaryDesc, &r.secondaryRole, &r.secondaryBonus, &r.secondaryIncrementType,
			&r.secondaryTroopMask, &r.sourceOrder); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "Perk not found: " + perkID, nil
	}

	blocks := make([]report.Block, 0, len(all))
	for i, r := range all {
		displayName, err := localizeFalsy(db, r.displayName, preferred)
		if err != nil {
			return "", err
		}
		primaryDesc, err := localizeFalsy(db, r.primaryDesc, preferred)
		if err != nil {
			return "", err
		}
		secondaryDesc, err := localizeFalsy(db, r.secondaryDesc, preferred)
		if err != nil {
			return "", err
		}

		// ★ THE ALTERNATIVE PERK LABEL HAS A THREE-WAY SHAPE, not a two-way one: no reference ->
		// null; a reference with no name -> the bare reference; a reference with a name ->
		// "localized [ref]". Collapsing the middle case into either neighbour changes the output.
		var altRef report.Scalar
		if r.alternativePerkID.String != "" {
			name, ok, err := lookupPerkName(db, r.alternativePerkID.String)
			if err != nil {
				return "", err
			}
			if ok {
				localized, err := localization.ResolveMaybeLocalizedText(db, name, preferred)
				if err != nil {
					return "", err
				}
				altRef = report.Text(localized + " [" + r.alternativePerkID.String + "]")
			} else {
				altRef = report.Text(r.alternativePerkID.String)
			}
		} else {
			altRef = report.Null()
		}

		blocks = append(blocks, report.Block{
			Header: "perk_" + report.Itoa(i+1),
			Fields: []report.Field{
				{Key: "source_path", Value: textScalar(r.filePath)},
				{Key: "perk_id", Value: textScalar(r.perkID)},
				{Key: "source_module", Value: textScalar(r.sourceModule)},
				{Key: "skill_id", Value: textScalar(r.skillID)},
				{Key: "tier_index", Value: numFromInt(r.tierIndex)},
				{Key: "required_skill_value", Value: numFromInt(r.requiredSkillValue)},
				{Key: "display_name", Value: displayName},
				{Key: "alternative_perk_ref", Value: altRef},
				{Key: "primary_role", Value: textScalar(r.primaryRole)},
				{Key: "primary_bonus", Value: numScalar(r.primaryBonus)},
				{Key: "primary_increment_type", Value: textScalar(r.primaryIncrementType)},
				{Key: "primary_troop_usage_mask", Value: numFromInt(r.primaryTroopMask)},
				{Key: "secondary_role", Value: textScalar(r.secondaryRole)},
				{Key: "secondary_bonus", Value: numScalar(r.secondaryBonus)},
				{Key: "secondary_increment_type", Value: textScalar(r.secondaryIncrementType)},
				{Key: "secondary_troop_usage_mask", Value: numFromInt(r.secondaryTroopMask)},
				{Key: "source_order", Value: numFromInt(r.sourceOrder)},
			},
			MultilineFields: []report.Field{
				{Key: "primary_description", Value: primaryDesc},
				{Key: "secondary_description", Value: secondaryDesc},
			},
		})
	}
	return report.Render("perk_data", "query_perk_id", perkID, blocks, nil), nil
}

// ── item stats ──────────────────────────────────────────────────────────────

func GetItemStats(db *sql.DB, itemID string, preferred []string) (string, error) {
	rows, err := db.Query(`
		SELECT entityId, entityKind, filePath, name, itemType, weight, value, weaponLength,
		       swingDamage, swingDamageType, thrustDamage, thrustDamageType, speedRating,
		       balanceOrHitPoints, headArmor, bodyArmor, legArmor, armArmor, horseChargeDamage,
		       horseSpeed, horseManeuver, tier, pieceType, length, materialCount
		FROM bannerlord_items
		WHERE entityId = ?
		ORDER BY entityKind, filePath`, itemID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type row struct {
		entityID, entityKind, filePath, name, itemType                   sql.NullString
		swingDamageType, thrustDamageType, pieceType                     sql.NullString
		weight, value, weaponLength, swingDamage, thrustDamage           sql.NullFloat64
		speedRating, balanceOrHitPoints, headArmor, bodyArmor            sql.NullFloat64
		legArmor, armArmor, horseChargeDamage, horseSpeed, horseManeuver sql.NullFloat64
		length                                                           sql.NullFloat64
		tier, materialCount                                              sql.NullInt64
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.entityID, &r.entityKind, &r.filePath, &r.name, &r.itemType,
			&r.weight, &r.value, &r.weaponLength, &r.swingDamage, &r.swingDamageType,
			&r.thrustDamage, &r.thrustDamageType, &r.speedRating, &r.balanceOrHitPoints,
			&r.headArmor, &r.bodyArmor, &r.legArmor, &r.armArmor, &r.horseChargeDamage,
			&r.horseSpeed, &r.horseManeuver, &r.tier, &r.pieceType, &r.length,
			&r.materialCount); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "Item or crafting piece not found: " + itemID, nil
	}

	blocks := make([]report.Block, 0, len(all))
	for i, r := range all {
		displayName, err := localizeText(db, r.name, preferred)
		if err != nil {
			return "", err
		}
		// ★ The header uses the entity KIND, so a crafting piece and an item with the same id get
		// differently-named blocks — and the empty-kind fallback is 'entity'.
		kind := r.entityKind.String
		if kind == "" {
			kind = "entity"
		}
		blocks = append(blocks, report.Block{
			Header: kind + "_" + report.Itoa(i+1),
			Fields: []report.Field{
				{Key: "source_path", Value: textScalar(r.filePath)},
				{Key: "entity_kind", Value: textScalar(r.entityKind)},
				{Key: "entity_id", Value: textScalar(r.entityID)},
				{Key: "display_name", Value: displayName},
				{Key: "item_type", Value: textScalar(r.itemType)},
				{Key: "weight", Value: numScalar(r.weight)},
				{Key: "value", Value: numScalar(r.value)},
				{Key: "weapon_length", Value: numScalar(r.weaponLength)},
				{Key: "swing_damage", Value: numScalar(r.swingDamage)},
				{Key: "swing_damage_type", Value: textScalar(r.swingDamageType)},
				{Key: "thrust_damage", Value: numScalar(r.thrustDamage)},
				{Key: "thrust_damage_type", Value: textScalar(r.thrustDamageType)},
				{Key: "speed_rating", Value: numScalar(r.speedRating)},
				{Key: "balance_or_hit_points", Value: numScalar(r.balanceOrHitPoints)},
				{Key: "head_armor", Value: numScalar(r.headArmor)},
				{Key: "body_armor", Value: numScalar(r.bodyArmor)},
				{Key: "leg_armor", Value: numScalar(r.legArmor)},
				{Key: "arm_armor", Value: numScalar(r.armArmor)},
				{Key: "horse_charge_damage", Value: numScalar(r.horseChargeDamage)},
				{Key: "horse_speed", Value: numScalar(r.horseSpeed)},
				{Key: "horse_maneuver", Value: numScalar(r.horseManeuver)},
				{Key: "tier", Value: numFromInt(r.tier)},
				{Key: "piece_type", Value: textScalar(r.pieceType)},
				{Key: "piece_length", Value: numScalar(r.length)},
				{Key: "material_count", Value: numFromInt(r.materialCount)},
			},
		})
	}
	return report.Render("item_stats", "query_item_id", itemID, blocks, nil), nil
}

// ── settlement summary ──────────────────────────────────────────────────────

func describeFactionReference(db *sql.DB, reference string, preferred []string) (string, string, error) {
	clan, err := entityresolver.LookupClanInfo(db, reference)
	if err != nil {
		return "", "", err
	}
	if clan != nil {
		ownerLabel, err := entityresolver.FormatReferenceLabel(db, reference, clan.Name, preferred)
		if err != nil {
			return "", "", err
		}
		kingdom, err := entityresolver.LookupKingdomInfo(db, clan.SuperFaction)
		if err != nil {
			return "", "", err
		}
		kingdomLabel := ""
		if kingdom != nil {
			kingdomLabel, err = entityresolver.FormatReferenceLabel(db, clan.SuperFaction, kingdom.Name, preferred)
			if err != nil {
				return "", "", err
			}
		}
		return ownerLabel, kingdomLabel, nil
	}

	kingdom, err := entityresolver.LookupKingdomInfo(db, reference)
	if err != nil {
		return "", "", err
	}
	if kingdom != nil {
		label, err := entityresolver.FormatReferenceLabel(db, reference, kingdom.Name, preferred)
		if err != nil {
			return "", "", err
		}
		// ★ The kingdom branch returns the SAME label for both owner and kingdom, which is
		// peculiar but observable.
		return label, label, nil
	}

	if reference == "" {
		return "unknown", "", nil
	}
	return reference, "", nil
}

func resolveSettlementOwner(db *sql.DB, ownerReference, boundSettlementReference string, preferred []string) (string, report.Scalar, error) {
	ownerLabel, kingdomLabel, err := describeFactionReference(db, ownerReference, preferred)
	if err != nil {
		return "", report.Null(), err
	}
	// ★ The test is against the literal 'unknown', not against emptiness: that is how the
	// original decides whether to fall back to the bound settlement's owner.
	if ownerLabel != "unknown" {
		var k report.Scalar
		if kingdomLabel != "" {
			k = report.Text(kingdomLabel)
		} else {
			k = report.Null()
		}
		return ownerLabel, k, nil
	}

	bound, err := entityresolver.LookupSettlementInfo(db, boundSettlementReference)
	if err != nil {
		return "", report.Null(), err
	}
	if bound != nil && bound.Owner != "" {
		o, k, err := describeFactionReference(db, bound.Owner, preferred)
		if err != nil {
			return "", report.Null(), err
		}
		var ks report.Scalar
		if k != "" {
			ks = report.Text(k)
		} else {
			ks = report.Null()
		}
		return o, ks, nil
	}
	return "unknown", report.Null(), nil
}

func GetSettlementSummary(db *sql.DB, settlementID string, preferred []string) (string, error) {
	rows, err := db.Query(`
		SELECT settlementId, filePath, name, descriptionText, owner, culture, settlementType,
		       componentId, boundSettlement, villageType, prosperityOrHearth, positionX,
		       positionY, sceneName, locationCount, buildingCount
		FROM bannerlord_settlements
		WHERE settlementId = ?
		ORDER BY
			CASE settlementType
				WHEN 'town' THEN 0
				WHEN 'castle' THEN 1
				WHEN 'village' THEN 2
				ELSE 3
			END,
			filePath`, settlementID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type row struct {
		settlementID, filePath, name, description, owner, culture sql.NullString
		settlementType, componentID, boundSettlement, villageType sql.NullString
		sceneName                                                 sql.NullString
		prosperity, positionX, positionY                          sql.NullFloat64
		locationCount, buildingCount                              sql.NullInt64
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.settlementID, &r.filePath, &r.name, &r.description, &r.owner,
			&r.culture, &r.settlementType, &r.componentID, &r.boundSettlement, &r.villageType,
			&r.prosperity, &r.positionX, &r.positionY, &r.sceneName, &r.locationCount,
			&r.buildingCount); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "Settlement not found: " + settlementID, nil
	}

	blocks := make([]report.Block, 0, len(all))
	for i, r := range all {
		displayName, err := localizeText(db, r.name, preferred)
		if err != nil {
			return "", err
		}
		description, err := localizeFalsy(db, r.description, preferred)
		if err != nil {
			return "", err
		}

		cultureName, _, err := entityresolver.LookupCultureName(db, r.culture.String)
		if err != nil {
			return "", err
		}
		cultureRef, err := entityresolver.FormatReferenceLabel(db, r.culture.String, cultureName, preferred)
		if err != nil {
			return "", err
		}

		ownerLabel, kingdomLabel, err := resolveSettlementOwner(db, r.owner.String, r.boundSettlement.String, preferred)
		if err != nil {
			return "", err
		}

		boundInfo, err := entityresolver.LookupSettlementInfo(db, r.boundSettlement.String)
		if err != nil {
			return "", err
		}
		boundRef, err := formatSettlementRef(db, r.boundSettlement.String, boundInfo, preferred)
		if err != nil {
			return "", err
		}

		blocks = append(blocks, report.Block{
			Header: "settlement_" + report.Itoa(i+1),
			Fields: []report.Field{
				{Key: "source_path", Value: textScalar(r.filePath)},
				{Key: "settlement_id", Value: textScalar(r.settlementID)},
				{Key: "display_name", Value: displayName},
				{Key: "settlement_type", Value: textScalar(r.settlementType)},
				{Key: "culture_ref", Value: report.Text(cultureRef)},
				{Key: "owner_faction_ref", Value: report.Text(ownerLabel)},
				{Key: "derived_kingdom_ref", Value: kingdomLabel},
				{Key: "bound_settlement_ref", Value: boundRef},
				{Key: "component_id", Value: textScalar(r.componentID)},
				{Key: "village_type", Value: textScalar(r.villageType)},
				{Key: "prosperity_or_hearth", Value: numScalar(r.prosperity)},
				{Key: "map_pos_x", Value: numScalar(r.positionX)},
				{Key: "map_pos_y", Value: numScalar(r.positionY)},
				{Key: "primary_scene", Value: textScalar(r.sceneName)},
				{Key: "location_node_count", Value: numFromInt(r.locationCount)},
				{Key: "building_node_count", Value: numFromInt(r.buildingCount)},
			},
			MultilineFields: []report.Field{{Key: "description", Value: description}},
		})
	}
	return report.Render("settlement_summary", "query_settlement_id", settlementID, blocks, nil), nil
}

// ── troop tree ──────────────────────────────────────────────────────────────

// TraceTroopTree mirrors traceTroopTree(characterId) from src/tools/trace-troop-tree.ts.
//
// It is the tenth get_entity kind. Two details worth naming: `skillTemplate || 'custom'` treats
// an EMPTY string as absent (JavaScript truthiness, so the literal fallback text appears), and
// the upgrade list comes from upgradeTargetsJson rather than from any indexed relation.
func TraceTroopTree(db *sql.DB, characterID string, preferred []string) (string, error) {
	rows, err := db.Query(`
		SELECT characterId, filePath, name, level, culture, occupation, skillTemplate,
		       isHero, isFemale, upgradeTargetsJson
		FROM bannerlord_troops
		WHERE characterId = ?
		ORDER BY filePath`, characterID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type row struct {
		characterID, filePath, name, culture, occupation, skillTemplate sql.NullString
		upgradeTargetsJSON                                              sql.NullString
		level, isHero, isFemale                                         sql.NullInt64
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.characterID, &r.filePath, &r.name, &r.level, &r.culture,
			&r.occupation, &r.skillTemplate, &r.isHero, &r.isFemale, &r.upgradeTargetsJSON); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "Troop not found: " + characterID, nil
	}

	blocks := make([]report.Block, 0, len(all))
	for i, r := range all {
		displayName, err := localizeText(db, r.name, preferred)
		if err != nil {
			return "", err
		}

		// `row.skillTemplate || 'custom'`: an empty string takes the fallback.
		var skillTemplate report.Scalar
		if r.skillTemplate.Valid && r.skillTemplate.String != "" {
			skillTemplate = report.Text(r.skillTemplate.String)
		} else {
			skillTemplate = report.Text("custom")
		}

		targets := parseIDList(r.upgradeTargetsJSON.String)
		values := make([]report.Scalar, 0, len(targets))
		for _, t := range targets {
			values = append(values, report.Text(t))
		}

		blocks = append(blocks, report.Block{
			Header: "troop_" + report.Itoa(i+1),
			Fields: []report.Field{
				{Key: "source_path", Value: textScalar(r.filePath)},
				{Key: "character_id", Value: textScalar(r.characterID)},
				{Key: "display_name", Value: displayName},
				{Key: "level", Value: numFromInt(r.level)},
				// ★ RAW refs, no lookups at all in this tool.
				{Key: "culture_ref", Value: textScalar(r.culture)},
				{Key: "occupation", Value: textScalar(r.occupation)},
				{Key: "skill_template", Value: skillTemplate},
				{Key: "is_hero", Value: boolText(jsTruthy(r.isHero))},
				{Key: "is_female", Value: boolText(jsTruthy(r.isFemale))},
			},
			ListFields: []report.ListField{{Key: "upgrade_target_ids", Values: values}},
		})
	}
	return report.Render("troop_tree", "query_character_id", characterID, blocks, nil), nil
}
