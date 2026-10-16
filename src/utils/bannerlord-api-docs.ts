/**
 * Version selection for the official API docs index. The installed game
 * version is matched against indexed API versions; when they agree the
 * official docs act as the authority, otherwise the local decompiled
 * source wins and the docs are demoted to historical reference.
 */
import type { Database } from 'bun:sqlite'
import type { SetupState } from './bannerlord-setup'

export const BANNERLORD_API_BASE_URL = 'https://apidoc.bannerlord.com/'

export const BANNERLORD_API_SECTIONS = [
  'classes',
  'functions',
  'properties',
  'events',
  'enums',
  'enumvalues',
  'variables',
] as const

export type BannerlordApiSection = (typeof BANNERLORD_API_SECTIONS)[number]

export type BannerlordApiVersionResolution = {
  installedGameVersion?: string
  installedFullVersion?: string
  requestedApiVersion?: string
  selectedApiVersion?: string
  exactMatch: boolean
  authority: 'official_api_reference' | 'local_decompiled_source'
  usage: 'reference' | 'historical_reference_only'
  warning?: string
  availableVersions: string[]
}

/** A version triple: exactly three numeric parts, joined with dots. */
const API_VERSION_PART_COUNT = 3

/** Normalizes "v1.2.9.x" style input to its first three numeric parts. */
export function normalizeApiVersion(value?: string): string | undefined {
  const withoutLeadingV = value?.trim().replace(/^v/i, '')
  if (!withoutLeadingV) return undefined

  const parts = withoutLeadingV
    .split('.')
    .map(part => part.trim())
    .filter(Boolean)

  const isTruncated = parts.length < API_VERSION_PART_COUNT
  if (isTruncated) {
    // Too short to pad: the caller sees only the parts that were present, and
    // an all-blank input collapses to undefined rather than an empty string.
    const joined = parts.join('.')
    return joined ? joined : undefined
  }

  return parts.slice(0, API_VERSION_PART_COUNT).join('.')
}

/** Numeric three-part comparison (non-numeric segments count as 0). */
export function compareApiVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left)
  const rightParts = parseVersionParts(right)
  const comparedSlots = Math.max(leftParts.length, rightParts.length)

  for (let slot = 0; slot < comparedSlots; slot += 1) {
    const leftValue = leftParts[slot] || 0
    const rightValue = rightParts[slot] || 0
    const delta = leftValue - rightValue
    if (delta !== 0) return delta
  }

  return 0
}

/** All indexed API versions, newest first by numeric comparison. */
export function readIndexedApiVersions(db: Database): string[] {
  if (!hasTable(db, 'bannerlord_api_versions')) {
    return []
  }

  const indexed = db
    .query<{ version: string }, never>(
      `
      SELECT version
      FROM bannerlord_api_versions
      ORDER BY version
    `
    )
    .all()

  return indexed.map(row => row.version).sort(compareNewestFirst)
}

function compareNewestFirst(left: string, right: string): number {
  return compareApiVersions(right, left)
}

export function resolveBannerlordApiVersion(
  db: Database,
  state: SetupState,
  requestedVersion?: string
): BannerlordApiVersionResolution {
  const availableVersions = readIndexedApiVersions(db)
  const normalizedRequested = normalizeApiVersion(requestedVersion)
  const installedGameVersion = state.gameVersion
  const installedFullVersion = state.fullVersion
  const normalizedInstalled = normalizeApiVersion(installedGameVersion || installedFullVersion)

  if (availableVersions.length === 0) {
    return {
      installedGameVersion,
      installedFullVersion,
      requestedApiVersion: normalizedRequested,
      exactMatch: false,
      authority: 'local_decompiled_source',
      usage: 'historical_reference_only',
      warning: 'Official API index is missing. Run bun run index:api-docs first.',
      availableVersions,
    }
  }

  if (normalizedRequested) {
    const selected = availableVersions.find(version => version === normalizedRequested)
    const isExactInstalledMatch = isSameVersion(selected, normalizedInstalled)

    return {
      installedGameVersion,
      installedFullVersion,
      requestedApiVersion: normalizedRequested,
      selectedApiVersion: selected,
      exactMatch: isExactInstalledMatch,
      authority: isExactInstalledMatch ? 'official_api_reference' : 'local_decompiled_source',
      usage: isExactInstalledMatch ? 'reference' : 'historical_reference_only',
      warning: selected
        ? buildVersionWarning(normalizedInstalled, selected)
        : `Requested official API version ${normalizedRequested} is not indexed.`,
      availableVersions,
    }
  }

  const exactInstalled = normalizedInstalled
    ? availableVersions.find(version => version === normalizedInstalled)
    : undefined
  const selected = exactInstalled || availableVersions[0]
  const installedIsIndexed = Boolean(exactInstalled)

  return {
    installedGameVersion,
    installedFullVersion,
    selectedApiVersion: selected,
    exactMatch: installedIsIndexed,
    authority: installedIsIndexed ? 'official_api_reference' : 'local_decompiled_source',
    usage: installedIsIndexed ? 'reference' : 'historical_reference_only',
    warning: installedIsIndexed ? undefined : buildVersionWarning(normalizedInstalled, selected),
    availableVersions,
  }
}

/** True only when both sides are known and name the same version. */
function isSameVersion(candidate: string | undefined, installed: string | undefined): boolean {
  if (candidate === undefined || !installed) {
    return false
  }

  return candidate === installed
}

function buildVersionWarning(installedVersion: string | undefined, selectedApiVersion: string | undefined): string | undefined {
  if (!selectedApiVersion) return undefined

  if (!installedVersion) {
    return `Installed game version is unknown; official API ${selectedApiVersion} is reference-only.`
  }

  if (installedVersion === selectedApiVersion) {
    return undefined
  }

  return `Installed game version ${installedVersion} does not match official API ${selectedApiVersion}; use local decompiled source as authority.`
}

function parseVersionParts(value: string): number[] {
  const segments = value.replace(/^v/i, '').split('.')

  return segments.map(segment => {
    const parsed = Number.parseInt(segment, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
}

function hasTable(db: Database, tableName: string): boolean {
  try {
    const row = db
      .query<{ name: string }, { $tableName: string }>(
        `
        SELECT name
        FROM sqlite_master
        WHERE type IN ('table', 'virtual') AND name = $tableName
      `
      )
      .get({ $tableName: tableName })

    return Boolean(row)
  } catch {
    return false
  }
}
