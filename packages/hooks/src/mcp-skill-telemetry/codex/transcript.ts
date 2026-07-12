export interface CodexSkillInjection {
  target: string
  path: string
  text: string
}

export function parseCodexSkillInjections(text: string): CodexSkillInjection[] {
  const injections: CodexSkillInjection[] = []
  const pattern = /<skill>\s*<name>\s*([^<]+?)\s*<\/name>\s*<path>\s*([^<]+?)\s*<\/path>[\s\S]*?<\/skill>/gi
  for (const match of text.matchAll(pattern)) {
    const target = match[1]?.trim()
    const path = match[2]?.trim()
    if (!target || !path || !/(?:^|[\\/])SKILL\.md$/i.test(path)) continue
    injections.push({ target, path, text: match[0] })
  }
  return injections
}
