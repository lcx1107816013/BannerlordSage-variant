// ─────────────────────────────────────────────────────────────────────────────
// Fixture-safety guard. READ THIS BEFORE DELETING ANY FILE.
//
// A fixture generator once deleted the real compiled index (ledger F19, P0): it derived
// the same database path the code under test resolves and removed the file before
// recreating it. "Be careful" is not a fix, because the same path is derived every run.
//
// The rule, made provable rather than assumed: a file is ours to delete ONLY IF WE MARKED
// IT. Every database this harness creates carries a `fixture_meta` table naming the
// generator. If a target exists without that marker, this script REFUSES TO RUN rather
// than deleting data it did not create.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'

export const FIXTURE_MARKER = 'bannerscribe-parity-fixture'

/** Reads the fixture marker from a database, or null if it has none. */
export function readFixtureMarker(path) {
    if (!existsSync(path)) return null
    let probe
    try {
        probe = new Database(path, { readonly: true })
        const row = probe.query(`SELECT value FROM fixture_meta WHERE key = 'generator'`).get()
        return row ? row.value : null
    } catch {
        // Unreadable, or not a database, or no such table — all mean "not ours".
        return null
    } finally {
        try {
            probe?.close()
        } catch {}
    }
}

/**
 * Removes a previous fixture database, or throws if the path holds something we did not
 * create. Call this instead of rmSync on any database path.
 */
export function removeOwnFixtureOrRefuse(path, generatorName) {
    if (!existsSync(path)) return
    const marker = readFixtureMarker(path)
    if (marker !== FIXTURE_MARKER) {
        throw new Error(
            `REFUSING TO DELETE ${path}: it is not a fixture created by this harness ` +
                `(marker: ${marker === null ? 'none' : JSON.stringify(marker)}). ` +
                `A path is ours to delete only if we marked it. If this really is a stale ` +
                `fixture, delete it by hand after checking what it is.`,
        )
    }
    rmSync(path, { force: true })
}

/** Stamps a freshly created fixture database so a later run may delete it. */
export function markAsFixture(db, generatorName) {
    db.run(`CREATE TABLE IF NOT EXISTS fixture_meta (key TEXT PRIMARY KEY, value TEXT)`)
    db.run(`INSERT OR REPLACE INTO fixture_meta (key, value) VALUES ('generator', ?)`, [
        FIXTURE_MARKER,
    ])
    db.run(`INSERT OR REPLACE INTO fixture_meta (key, value) VALUES ('generator_name', ?)`, [
        generatorName,
    ])
}
