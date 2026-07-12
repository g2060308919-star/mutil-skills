export interface ClaudeDirectExpansion {
  command: string
  content: string
}

export function parseClaudeDirectExpansion(text: string): ClaudeDirectExpansion | null {
  const command = /<command-name>\/?([^<]+)<\/command-name>/.exec(text)?.[1]
  if (!command) return null
  const content = text.replace(/<command-(?:name|message)>[\s\S]*?<\/command-(?:name|message)>/g, '').trim()
  return content ? { command, content } : null
}
