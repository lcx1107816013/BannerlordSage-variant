// Package entityresolver mirrors src/utils/bannerlord-entity-resolver.ts: it turns a raw
// reference from one gameplay table into a human-readable label by looking the target up in
// another table, preferring the target's name but always keeping the raw id visible.
package entityresolver

import (
	"database/sql"

	"blore/internal/localization"
	"blore/internal/policyid"
)

// NormalizeReference mirrors normalizeReference: strip ONE matching prefix from a list.
//
// ★ The prefixes are checked IN ORDER and only the FIRST match is applied, then the remainder is
// returned as-is. So `"Faction.Kingdom.X"` with prefixes ['Faction.', 'Kingdom.'] becomes
// `"Kingdom.X"`, not `"X"`. That is faithful and it matters: the caller then queries a table
// keyed by the remaining string.
func NormalizeReference(value string, prefixes []string) (string, bool) {
	if value == "" {
		return "", false
	}
	for _, prefix := range prefixes {
		if len(prefix) <= len(value) && value[:len(prefix)] == prefix {
			return value[len(prefix):], true
		}
	}
	return value, true
}

// ClanInfo mirrors BannerlordClanInfo.
type ClanInfo struct {
	ClanID         string
	Name           string
	SuperFaction   string
	IsNoble        int
	IsMinorFaction int
	IsBandit       int
	IsMercenary    int
}

// KingdomInfo mirrors BannerlordKingdomInfo.
type KingdomInfo struct {
	KingdomID string
	Name      string
}

// SettlementInfo mirrors BannerlordSettlementInfo.
type SettlementInfo struct {
	SettlementID    string
	Name            string
	Owner           string
	BoundSettlement string
	SettlementType  string
}

// cultureOrder is shared by LookupCultureName and the culture summary tool: SQL's ORDER BY for
// that table. Kept as one constant so the two cannot drift, because a mismatch would pick a
// different row for the same id depending on which tool asked.
const cultureOrder = `
	ORDER BY
		(maleNameCount + femaleNameCount) DESC,
		CASE WHEN descriptionText IS NOT NULL AND descriptionText <> '' THEN 0 ELSE 1 END,
		filePath`

// LookupCultureName mirrors lookupCultureName.
func LookupCultureName(db *sql.DB, reference string) (string, bool, error) {
	cultureID, ok := NormalizeReference(reference, []string{"Culture."})
	if !ok {
		return "", false, nil
	}
	var name sql.NullString
	err := db.QueryRow(`SELECT name FROM bannerlord_cultures WHERE cultureId = ?`+cultureOrder+` LIMIT 1`,
		cultureID).Scan(&name)
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

// LookupHeroName mirrors lookupHeroName: the name comes from bannerlord_TROOPS, keyed by
// characterId, not from bannerlord_heroes.
func LookupHeroName(db *sql.DB, reference string) (string, bool, error) {
	heroID, ok := NormalizeReference(reference, []string{"Hero.", "NPCCharacter."})
	if !ok {
		return "", false, nil
	}
	var name sql.NullString
	err := db.QueryRow(`SELECT name FROM bannerlord_troops WHERE characterId = ? ORDER BY filePath LIMIT 1`,
		heroID).Scan(&name)
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

// LookupClanInfo mirrors lookupClanInfo, including its ORDER BY which prefers noble clans.
func LookupClanInfo(db *sql.DB, reference string) (*ClanInfo, error) {
	clanID, ok := NormalizeReference(reference, []string{"Faction.", "Clan."})
	if !ok {
		return nil, nil
	}
	var info ClanInfo
	var name, superFaction sql.NullString
	err := db.QueryRow(`
		SELECT clanId, name, superFaction, isNoble, isMinorFaction, isBandit, isMercenary
		FROM bannerlord_clans
		WHERE clanId = ?
		ORDER BY
			CASE WHEN isNoble = 1 THEN 0 WHEN isMinorFaction = 1 THEN 1 ELSE 2 END,
			filePath
		LIMIT 1`, clanID).
		Scan(&info.ClanID, &name, &superFaction, &info.IsNoble, &info.IsMinorFaction,
			&info.IsBandit, &info.IsMercenary)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	info.Name = name.String
	info.SuperFaction = superFaction.String
	return &info, nil
}

// LookupKingdomInfo mirrors lookupKingdomInfo.
func LookupKingdomInfo(db *sql.DB, reference string) (*KingdomInfo, error) {
	kingdomID, ok := NormalizeReference(reference, []string{"Faction.", "Kingdom."})
	if !ok {
		return nil, nil
	}
	var info KingdomInfo
	var name sql.NullString
	err := db.QueryRow(`SELECT kingdomId, name FROM bannerlord_kingdoms WHERE kingdomId = ? ORDER BY filePath LIMIT 1`,
		kingdomID).Scan(&info.KingdomID, &name)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	info.Name = name.String
	return &info, nil
}

// LookupPolicyName mirrors lookupPolicyName.
func LookupPolicyName(db *sql.DB, reference string) (string, bool, error) {
	policyID, ok := policyid.Normalize(reference)
	if !ok {
		return "", false, nil
	}
	var displayName sql.NullString
	err := db.QueryRow(`SELECT displayName FROM bannerlord_policies WHERE policyId = ? LIMIT 1`,
		policyID).Scan(&displayName)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !displayName.Valid {
		return "", false, nil
	}
	return displayName.String, true, nil
}

// LookupSettlementInfo mirrors lookupSettlementInfo.
func LookupSettlementInfo(db *sql.DB, reference string) (*SettlementInfo, error) {
	settlementID, ok := NormalizeReference(reference, []string{"Settlement."})
	if !ok {
		return nil, nil
	}
	var info SettlementInfo
	var name, owner, bound, stype sql.NullString
	err := db.QueryRow(`
		SELECT settlementId, name, owner, boundSettlement, settlementType
		FROM bannerlord_settlements
		WHERE settlementId = ?
		ORDER BY filePath
		LIMIT 1`, settlementID).Scan(&info.SettlementID, &name, &owner, &bound, &stype)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	info.Name = name.String
	info.Owner = owner.String
	info.BoundSettlement = bound.String
	info.SettlementType = stype.String
	return &info, nil
}

// FormatReferenceLabel mirrors formatReferenceLabel.
//
// The shape is `"<localized name> [<raw ref>]"` when both are known, and just the raw reference
// when the name is missing. Note `rawReference || 'unknown'` — an EMPTY raw reference with no
// name yields "unknown", while a FALSY-but-present one cannot occur since the type is
// string|null.
func FormatReferenceLabel(db *sql.DB, rawReference string, displayName string, displayNameKnown bool, preferred []string) (string, error) {
	if displayNameKnown {
		localized, err := localization.ResolveMaybeLocalizedText(db, displayName, preferred)
		if err != nil {
			return "", err
		}
		if rawReference != "" {
			return localized + " [" + rawReference + "]", nil
		}
		return localized, nil
	}
	if rawReference != "" {
		return rawReference, nil
	}
	return "unknown", nil
}
