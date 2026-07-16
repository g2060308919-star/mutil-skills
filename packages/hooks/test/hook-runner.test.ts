import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test, vi } from 'vitest'
import { createTemporaryTelemetryVerification, reconcileTranscript, runTelemetryHook, TemporaryJsonlTelemetrySink, type TelemetryLifecycleEvent, type TelemetrySink } from '../src/index.js'

describe('runTelemetryHook', () => {
  test('explicit verification captures events in a private temporary file and cleans them up', async () => {
    const verification = await createTemporaryTelemetryVerification()
    const event = {
      schemaVersion: 1,
      runtime: 'codex',
      type: 'mcp',
      target: 'smoke/ping',
      callId: 'verify-call',
      sessionId: 'verify-session',
      turnId: 'verify-turn',
      nativeTurnId: 'verify-turn',
      phase: 'completed',
      status: 'success',
      failureKind: null,
      errorCode: null,
      nativeErrorCode: null,
      errorMessage: null,
      timestamp: '2026-07-11T10:00:00.000Z',
      projectHash: 'project-hash',
      source: 'post_tool_use',
      log: { prompt: null, input: {}, output: { ok: true }, error: null },
    } satisfies TelemetryLifecycleEvent

    await verification.sink.send(event)

    expect(await verification.readEvents()).toEqual([event])
    expect((await stat(verification.outputPath)).mode & 0o777).toBe(0o600)
    await verification.cleanup()
    await expect(readFile(verification.outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('refuses a symlinked verification output instead of following it outside the root', async () => {
    const verification = await createTemporaryTelemetryVerification()
    const outsidePath = join(tmpdir(), `telemetry-outside-${Date.now()}.jsonl`)
    const linkedPath = join(verification.outputPath, '..', 'linked-events.jsonl')
    await writeFile(outsidePath, 'unchanged\n')
    await symlink(outsidePath, linkedPath)
    const sink = new TemporaryJsonlTelemetrySink(linkedPath)

    await expect(sink.send({} as TelemetryLifecycleEvent)).rejects.toThrow(/symbolic link|symlink/i)
    expect(await readFile(outsidePath, 'utf8')).toBe('unchanged\n')
    await rm(linkedPath, { force: true })
    await rm(outsidePath, { force: true })
    await verification.cleanup()
  })

  test('exits before transcript access or sink calls for an excluded project', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-runner-'))
    const cwd = await mkdtemp(join(tmpdir(), 'excluded-project-'))
    await mkdir(join(homeDir, '.mutil-skills'))
    await writeFile(join(homeDir, '.mutil-skills', 'telemetry.json'), JSON.stringify({ excludedProjects: [cwd] }))
    const sink: TelemetrySink = { send: vi.fn() }
    const readTranscript = vi.fn()

    const result = await runTelemetryHook({
      runtime: 'codex',
      eventName: 'Stop',
      payload: { cwd, transcript_path: '/sensitive/transcript.jsonl' },
      homeDir,
      sink,
      readTranscript,
    })

    expect(result).toEqual({ skipped: true, eventCount: 0, errors: [] })
    expect(readTranscript).not.toHaveBeenCalled()
    expect(sink.send).not.toHaveBeenCalled()
  })

  test('sends normalized events only to the injected sink', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-runner-'))
    await mkdir(join(homeDir, '.mutil-skills'))
    await writeFile(join(homeDir, '.mutil-skills', 'telemetry.key'), 'a'.repeat(64))
    const sent: unknown[] = []

    const result = await runTelemetryHook({
      runtime: 'claude-code',
      eventName: 'PostToolUse',
      payload: {
        cwd: '/repo',
        session_id: 'session',
        tool_name: 'mcp__db__query',
        tool_use_id: 'call',
        tool_response: { rows: [] },
      },
      homeDir,
      sink: { async send(event) { sent.push(event) } },
    })

    expect(result).toEqual({ skipped: false, eventCount: 1, errors: [] })
    expect(sent).toEqual([expect.objectContaining({ status: 'success', target: 'db/query' })])
  })

  test('derives the same direct Skill call id as transcript reconciliation', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-direct-runner-'))
    await mkdir(join(homeDir, '.mutil-skills'))
    await writeFile(join(homeDir, '.mutil-skills', 'telemetry.key'), 'b'.repeat(64))
    const transcript = JSON.stringify({
      type: 'user',
      sessionId: 'direct-session',
      cwd: '/repo',
      message: { content: '<command-name>/tdd</command-name>\n# expanded skill contents' },
    })
    const sent: TelemetryLifecycleEvent[] = []

    await runTelemetryHook({
      runtime: 'claude-code',
      eventName: 'UserPromptExpansion',
      payload: {
        cwd: '/repo',
        session_id: 'direct-session',
        transcript_path: '/transcript.jsonl',
        expansion_type: 'slash_command',
        command_name: 'tdd',
        prompt: '/tdd',
      },
      homeDir,
      readTranscript: async () => transcript,
      sink: { async send(event) { sent.push(event) } },
    })

    const reconciled = reconcileTranscript('claude-code', transcript, {
      projectSecret: 'b'.repeat(64),
      cwd: '/repo',
      sessionId: 'direct-session',
    })
    expect(sent[0]?.callId).toBe(reconciled.events[0]?.callId)
  })
})
