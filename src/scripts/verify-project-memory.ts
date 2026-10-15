import { existsSync, rmSync } from 'node:fs'
import { projectMemoryAdd } from '../tools/project-memory-add'
import { projectMemoryCaptureSession } from '../tools/project-memory-capture-session'
import { projectMemoryInvalidate } from '../tools/project-memory-invalidate'
import { projectMemoryRecent } from '../tools/project-memory-recent'
import { projectMemorySearch } from '../tools/project-memory-search'
import { projectMemoryWakeup } from '../tools/project-memory-wakeup'
import { closeMemoryDb } from '../utils/memory-db'
import { getGamePaths } from '../utils/env'

/**
 * End-to-end verification of the project-memory sidecar DB. Runs against a
 * dedicated fake game id so the real `bannerlord` memory database is never
 * touched; that guarantee is itself asserted at the end.
 */
const TEST_GAME_ID = 'bannerlord-memory-smoke'

const SAMPLE_MEMORY_TEXT =
  'Store project memory in a sidecar SQLite database instead of mixing it into the gameplay index.'

async function main() {
  process.env.BANNERSAGE_GAME = TEST_GAME_ID
  const paths = getGamePaths(TEST_GAME_ID)
  const defaultPaths = getGamePaths('bannerlord')
  const defaultMemoryDbExistedBefore = existsSync(defaultPaths.memoryDbPath)
  await removeDatabaseFiles(paths.memoryDbPath)

  try {
    const added = await projectMemoryAdd(
      SAMPLE_MEMORY_TEXT,
      'bannerlordsage',
      'memory',
      'decision',
      'Keep memory sidecar DB',
      'verify-memory',
      ['memory', 'sqlite'],
      5
    )
    assertIncludes(added.content[0]?.text, 'project_memory_add', 'single add report')

    // An identical add must be recognized as a duplicate and return the
    // original id instead of creating a second row.
    const deduped = await projectMemoryAdd(
      SAMPLE_MEMORY_TEXT,
      'bannerlordsage',
      'memory',
      'decision',
      'Keep memory sidecar DB',
      'verify-memory',
      ['memory', 'sqlite'],
      5
    )
    const addedId = extractMemoryId(added.content[0]?.text)
    const dedupedId = extractMemoryId(deduped.content[0]?.text)
    assert(addedId !== '' && addedId === dedupedId, 'exact duplicate suppression')

    const captured = await projectMemoryCaptureSession(
      'bannerlordsage',
      'memory',
      'verify-memory',
      'Session captured durable memory rules',
      ['Prefer batch capture for end-task memory writes.'],
      ['Do not store every command output as memory.'],
      ['Prefer concrete summaries over verbose transcripts.'],
      ['Document the workflow in README and AGENTS.'],
      ['Session capture should be the default end-of-task path.'],
      4
    )
    assertIncludes(captured.content[0]?.text, 'project_memory_capture_session', 'capture session report')

    const search = await projectMemorySearch('batch capture', 'bannerlordsage', 'memory')
    assertIncludes(search.content[0]?.text, 'project_memory_search', 'search report')

    const recent = await projectMemoryRecent('bannerlordsage', 'memory')
    assertIncludes(recent.content[0]?.text, 'project_memory_recent', 'recent report')

    const wakeup = await projectMemoryWakeup('bannerlordsage')
    assertIncludes(wakeup.content[0]?.text, 'project_memory_wakeup', 'wakeup report')

    assert(containsMemoryId(recent.content[0]?.text, addedId), 'recent list contains added memory')
    assert(containsMemoryId(wakeup.content[0]?.text, addedId), 'wakeup contains important decision')

    const invalidated = await projectMemoryInvalidate(addedId, 'verify cleanup')
    assertIncludes(invalidated.content[0]?.text, 'project_memory_invalidate', 'invalidate report')

    // Default search hides invalidated rows; the explicit include-inactive
    // flag must bring them back.
    const activeSearch = await projectMemorySearch('sidecar SQLite database', 'bannerlordsage', 'memory')
    assert(!containsMemoryId(activeSearch.content[0]?.text, addedId), 'inactive memories excluded from default search')

    const searchWithInactive = await projectMemorySearch(
      'sidecar SQLite database',
      'bannerlordsage',
      'memory',
      undefined,
      5,
      true
    )
    assert(containsMemoryId(searchWithInactive.content[0]?.text, addedId), 'inactive memories included when requested')

    console.log('Project memory verification passed.')
  } finally {
    closeMemoryDb()
    if (!defaultMemoryDbExistedBefore) {
      assert(!existsSync(defaultPaths.memoryDbPath), 'verify script must not write to default bannerlord memory DB')
    }
    await removeDatabaseFiles(paths.memoryDbPath)
  }
}

/** Deletes the SQLite file plus its WAL/SHM sidecars, retrying briefly on locks. */
async function removeDatabaseFiles(basePath: string) {
  for (const suffix of ['', '-shm', '-wal']) {
    const path = `${basePath}${suffix}`
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!existsSync(path)) {
        break
      }

      try {
        rmSync(path, { force: true })
        break
      } catch (error) {
        if (attempt === 4) {
          throw error
        }

        await Bun.sleep(100 * (attempt + 1))
      }
    }
  }
}

function assert(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(`Verification failed: ${label}`)
  }
}

function assertIncludes(value: string | undefined, needle: string, label: string) {
  assert(String(value || '').includes(needle), label)
}

function extractMemoryId(text: string | undefined): string {
  const match = String(text || '').match(/stored_memory_id:\s*(pmem_[a-z0-9]+)/i)
  return match?.[1] || ''
}

function containsMemoryId(text: string | undefined, memoryId: string): boolean {
  if (!memoryId) return false
  return String(text || '').includes(memoryId)
}

main().catch(error => {
  console.error('Project memory verification failed:', error)
  process.exit(1)
})
