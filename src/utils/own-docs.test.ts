import { describe, expect, test } from 'bun:test'
import { slugify, splitMarkdownIntoSections, stripFrontmatter, titleFromFile } from './own-docs'

describe('own-docs markdown splitter', () => {
  test('strips YAML frontmatter', () => {
    const md = '---\nname: x\ndescription: y\n---\n\n# Title\n\nBody.'
    expect(stripFrontmatter(md)).not.toContain('frontmatter-marker')
    expect(stripFrontmatter(md).startsWith('---')).toBe(false)
    expect(stripFrontmatter(md)).toContain('# Title')
  })

  test('markdown without frontmatter passes through', () => {
    expect(stripFrontmatter('# Just a title')).toBe('# Just a title')
  })

  test('splits on ## headings and keeps intro before the first ##', () => {
    const md = [
      '# Guide',
      '',
      'Intro paragraph.',
      '',
      '## First Section',
      'alpha content',
      '',
      '## Second Section',
      'beta content',
    ].join('\n')
    const sections = splitMarkdownIntoSections(md)
    expect(sections.length).toBe(3)
    expect(sections[0]).toEqual({ slug: 'intro', heading: '', content: '# Guide\n\nIntro paragraph.' })
    expect(sections[1].slug).toBe('first-section')
    expect(sections[1].content).toContain('alpha content')
    expect(sections[2].slug).toBe('second-section')
  })

  test('does not split on ### subheadings', () => {
    const md = '## Parent\n\n### Child\n\ntext'
    const sections = splitMarkdownIntoSections(md)
    expect(sections.length).toBe(1)
    expect(sections[0].content).toContain('### Child')
  })

  test('handles CJK headings in slugs', () => {
    expect(slugify('加载顺序 与 依赖')).toBe('加载顺序-与-依赖')
    expect(slugify('!!!')).toBe('section')
  })

  test('title falls back to H1 then filename', () => {
    expect(titleFromFile('# My Title\n\ntext', 'knowledge/modding/x.md')).toBe('My Title')
    expect(titleFromFile('no heading here', 'knowledge/modding/y.md')).toBe('modding/y')
  })
})
