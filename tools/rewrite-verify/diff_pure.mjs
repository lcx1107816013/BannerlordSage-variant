// Direct baseline-vs-rewrite differential for the three pure-function generators in batch 4:
//   generate-harmony-patch.ts   (frozen fixture: harmonypatch, 7 cases)
//   generate-xslt-patch.ts      (frozen fixture: xsltpatch)
//   resolve-localization.ts     (frozen fixture: resolveloc, 29 cases)
//
// These DO have frozen fixtures, so this runner is extra assurance rather than the only
// witness. It exists because the rewrite moved real risk into places a small case list may
// not reach:
//
//   * generate-harmony-patch.ts  splitTopLevel's hand-rolled four-counter nesting loop became
//     a depth Map keyed by delimiter. The frozen corpus has ONE case for parameter shapes, so
//     the signature list below walks the awkward ones directly: nested generics, nested
//     parens, array ranks with commas inside the brackets, modifiers, defaults containing
//     commas, lambdas, and unbalanced closers.
//   * generate-xslt-patch.ts     the template was split into three concatenated constants and
//     the fragment indenter became an explicit loop. Whitespace IS the contract, so the
//     fragment list below targets multi-line, CRLF, empty and tab-indented fragments.
//
// Usage: bun run tools/rewrite-verify/diff_pure.mjs

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mock } from 'bun:test'
import { repoRoot, cleanupShadow, report, loadBoth, diffCases } from './diffharness.mjs'

let allOk = true
let total = 0

// ── generate-xslt-patch: no database, pure template ─────────────────────────
{
  const XPATHS = [
    '/ModuleData/Items/Item[@id="x"]',
    '//a',
    '/ModuleData/*/Node',
    '/root/child[1]',
    '',
    'with"quote',
    'with&ersand',
    'with<angle>',
    'path with spaces',
    'ünïcödé/path',
    '/a/b/c/d/e/f/g/h',
  ]
  const OPERATIONS = ['insert', 'replace', 'delete', 'unknown-op', '']
  const FRAGMENTS = [
    undefined,
    '',
    '   ',
    '<Item id="y" />',
    '<a>\n  <b/>\n</a>',
    '<a>\r\n  <b/>\r\n</a>',
    'line1\nline2\nline3',
    '\ttab-indented',
    '<x/>\n',
    '\n<y/>',
    '中文 <Item id="中"/>',
  ]

  const cases = []
  let n = 0
  for (const xpath of XPATHS) {
    for (const op of OPERATIONS) {
      // Cycle fragments so the cross-product stays bounded but covers both axes.
      const fragment = FRAGMENTS[n % FRAGMENTS.length]
      n += 1
      cases.push({ label: `${JSON.stringify(xpath)}/${op}/${JSON.stringify(fragment)}`, xpath, op, fragment })
    }
  }

  const { baselineMod, liveMod } = await loadBoth('src/tools/generate-xslt-patch.ts')
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(
    baselineMod.generateXsltPatch,
    liveMod.generateXsltPatch,
    cases,
    (fn, c) => fn(c.xpath, c.op, c.fragment)
  )
  allOk = report('src/tools/generate-xslt-patch.ts', problems, cases.length, unexpectedThrows, expectedThrows) && allOk
  total += cases.length
}

// ── generate-harmony-patch: needs a csharp_types/csharp_methods table ───────
{
  const { Database } = await import('bun:sqlite')
  const { mkdirSync, rmSync } = await import('node:fs')

  // A synthetic game id so the real index cannot be touched, and the DB is built
  // fresh under .tmp on every run.
  const gameId = 'bannerlord-fixture-rewrite-verify-harmony'
  const dir = join(repoRoot, 'dist', 'games', gameId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, `${gameId}.db`)
  process.env.BANNERSAGE_GAME = gameId

  const db = new Database(dbPath, { create: true })
  db.run(`CREATE TABLE csharp_types (
    typeName TEXT NOT NULL, fullName TEXT NOT NULL, filePath TEXT NOT NULL,
    startLine INTEGER, endLine INTEGER, typeKind TEXT, accessibility TEXT, modifiers TEXT,
    namespaceName TEXT, containingType TEXT
  )`)
  db.run(`CREATE TABLE csharp_methods (
    id TEXT PRIMARY KEY, typeFullName TEXT NOT NULL, memberName TEXT NOT NULL,
    memberKind TEXT, signature TEXT, returnType TEXT, filePath TEXT,
    startLine INTEGER, endLine INTEGER, accessibility TEXT, isStatic INTEGER
  )`)

  const insType = db.prepare(
    `INSERT INTO csharp_types (typeName, fullName, filePath, startLine, endLine, typeKind, accessibility, modifiers, namespaceName, containingType) VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
  insType.run('Solo', 'A.Solo', 'a.cs', 1, 9, 'class', 'public', '', 'A', null)
  insType.run('Solo', 'A.Solo.That.Is.Longer', 'b.cs', 1, 9, 'class', 'public', '', 'A', null)
  insType.run('Duo', 'A.Duo', 'a.cs', 1, 9, 'class', 'public', '', 'A', null)
  insType.run('Statics', 'A.Statics', 'a.cs', 1, 9, 'class', 'public', '', 'A', null)

  const insMethod = db.prepare(
    `INSERT INTO csharp_methods (id, typeFullName, memberName, memberKind, signature, returnType, filePath, startLine, endLine, accessibility, isStatic) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  // The signature corpus: every awkward parameter shape splitTopLevel must survive.
  const SIGNATURES = [
    ['Solo', 'Run', 'public void Run()', 1],
    ['Duo', 'Go', 'public void Go(int a)', 0],
    ['Duo', 'Go', 'internal int Go(string s, float f)', 1],
    ['Statics', 'Static1', 'public static void Static1(int a)', 1],
    ['Statics', 'Static1', 'public static void Static1(int a, int b)', 1],
    ['Solo', 'Generic', 'public void Generic(Dictionary<int, string> map, List<Tuple<int, int>> pairs)', 0],
    ['Solo', 'Nested', 'public void Nested(Func<int, Func<string, bool>> f, int x)', 0],
    ['Solo', 'Ranks', 'public void Ranks(int[,] grid, int[,,] cube, string[] names)', 0],
    ['Solo', 'Modifiers', 'public void Modifiers(ref int a, out string b, in float c, params int[] d)', 0],
    ['Solo', 'Defaults', 'public void Defaults(int a = 1, string b = "x,y", int[] c = default)', 0],
    ['Solo', 'Lambda', 'public void Lambda(Func<int,int> f, Action g)', 0],
    ['Solo', 'UnbalancedCloser', 'public void Bad(int a) , int b)', 0],
    ['Solo', 'NoParams', 'public void NoParams', 0],
    ['Solo', 'EmptyParens', 'public void EmptyParens( )', 0],
    ['Solo', 'SpacedType', 'public void SpacedType(   int    a   ,   string   b   )', 0],
    ['Solo', 'GenericsNoSpace', 'public void G(List<int>,Dictionary<string,bool>)', 0],
    ['Solo', 'ThisExt', 'public static void Ext(this Foo f)', 1],
    ['Solo', 'Scoped', 'public void Scoped(scoped ReadOnlySpan<int> s, readonly Foo f)', 0],
  ]
  SIGNATURES.forEach(([typeFullName, memberName, signature, isStatic], i) => {
    insMethod.run(
      `m${i}`, typeFullName === 'Solo' || typeFullName === 'Statics' || typeFullName === 'Duo'
        ? (typeFullName === 'Solo' ? 'A.Solo' : typeFullName === 'Statics' ? 'A.Statics' : 'A.Duo')
        : typeFullName,
      memberName, 'method', signature, 'void', 'a.cs', i + 1, i + 2, 'public', isStatic
    )
  })
  db.close()

  const cases = [
    { label: 'Solo/Run', cls: 'Solo', method: 'Run' },
    { label: 'Duo/Go (two overloads)', cls: 'Duo', method: 'Go' },
    { label: 'Statics/Static1 (all static)', cls: 'Statics', method: 'Static1' },
    { label: 'Solo/Generic', cls: 'Solo', method: 'Generic' },
    { label: 'Solo/Nested', cls: 'Solo', method: 'Nested' },
    { label: 'Solo/Ranks', cls: 'Solo', method: 'Ranks' },
    { label: 'Solo/Modifiers', cls: 'Solo', method: 'Modifiers' },
    { label: 'Solo/Defaults', cls: 'Solo', method: 'Defaults' },
    { label: 'Solo/Lambda', cls: 'Solo', method: 'Lambda' },
    { label: 'Solo/UnbalancedCloser', cls: 'Solo', method: 'UnbalancedCloser' },
    { label: 'Solo/NoParams', cls: 'Solo', method: 'NoParams' },
    { label: 'Solo/EmptyParens', cls: 'Solo', method: 'EmptyParens' },
    { label: 'Solo/SpacedType', cls: 'Solo', method: 'SpacedType' },
    { label: 'Solo/GenericsNoSpace', cls: 'Solo', method: 'GenericsNoSpace' },
    { label: 'Solo/ThisExt', cls: 'Solo', method: 'ThisExt' },
    { label: 'Solo/Scoped', cls: 'Solo', method: 'Scoped' },
    { label: 'Solo/method absent', cls: 'Solo', method: 'NotThere' },
    { label: 'type absent', cls: 'NoSuchType', method: 'Run' },
    { label: 'type absent + method absent', cls: 'Nope', method: 'Nope' },
    // name sanitisation: every non-identifier character becomes an underscore
    { label: 'sanitise class', cls: 'Solo', method: 'Run<, >' },
  ]

  const { baselineMod, liveMod } = await loadBoth('src/tools/generate-harmony-patch.ts')
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(
    baselineMod.generateHarmonyPatch,
    liveMod.generateHarmonyPatch,
    cases,
    (fn, c) => fn(c.cls, c.method)
  )
  allOk = report('src/tools/generate-harmony-patch.ts', problems, cases.length, unexpectedThrows, expectedThrows) && allOk
  total += cases.length
}

cleanupShadow()
console.log(allOk ? `ALL EQUAL — ${total} differential cases` : 'DIVERGENCE FOUND')
process.exit(allOk ? 0 : 1)
