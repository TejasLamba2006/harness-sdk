import { afterEach, describe, expect, it } from 'vitest'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function createTwoToolsModel(firstName: string, secondName: string): MockMessageModel {
  return new MockMessageModel()
    .addTurn([
      { type: 'toolUseBlock', name: firstName, toolUseId: 'call-a', input: {} },
      { type: 'toolUseBlock', name: secondName, toolUseId: 'call-b', input: {} },
    ])
    .addTurn({ type: 'textBlock', text: 'Done' })
}

function createDelayedTool(name: string, ms: number, options?: { shouldThrow?: boolean }) {
  // eslint-disable-next-line require-yield
  return createMockTool(name, async function* (context) {
    await delay(ms)
    if (options?.shouldThrow) {
      throw new Error(`${name} failed`)
    }
    return new ToolResultBlock({
      toolUseId: context.toolUse.toolUseId,
      status: 'success',
      content: [new TextBlock(`${name} ok`)],
    })
  })
}

describe('Agent concurrent local tool traces', () => {
  let provider: NodeTracerProvider | undefined

  afterEach(async () => {
    if (provider) {
      await provider.forceFlush()
      await provider.shutdown()
      provider = undefined
    }
    trace.disable()
  })

  it('ends both local tool traces at their own completion times without OTel configured', async () => {
    trace.disable()

    const agent = new Agent({
      model: createTwoToolsModel('slow_a', 'slow_b'),
      tools: [createDelayedTool('slow_a', 50), createDelayedTool('slow_b', 120)],
      printer: false,
    })

    const result = await agent.invoke('Run both tools')

    const cycle1 = result.traces?.[0]
    expect(cycle1).toBeDefined()
    const toolTraces = cycle1!.children.filter((t) => t.name.startsWith('Tool: '))
    expect(toolTraces).toHaveLength(2)

    const traceA = toolTraces.find((t) => t.name === 'Tool: slow_a')!
    const traceB = toolTraces.find((t) => t.name === 'Tool: slow_b')!

    expect(traceA.metadata).toEqual({ toolUseId: 'call-a', toolName: 'slow_a' })
    expect(traceB.metadata).toEqual({ toolUseId: 'call-b', toolName: 'slow_b' })
    expect(traceA.endTime).not.toBeNull()
    expect(traceB.endTime).not.toBeNull()
    expect(traceA.duration).toBeGreaterThanOrEqual(40)
    expect(traceB.duration).toBeGreaterThanOrEqual(100)
    expect(traceB.endTime!).toBeGreaterThan(traceA.endTime!)
    expect(traceB.duration).toBeGreaterThan(traceA.duration)
  })

  it('ends both local tool traces and OTel spans independently when OTel is configured', async () => {
    const exporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    provider.register()

    const agent = new Agent({
      model: createTwoToolsModel('slow_a', 'slow_b'),
      tools: [createDelayedTool('slow_a', 50), createDelayedTool('slow_b', 120)],
      printer: false,
    })

    const result = await agent.invoke('Run both tools')

    const cycle1 = result.traces?.[0]
    expect(cycle1).toBeDefined()
    const toolTraces = cycle1!.children.filter((t) => t.name.startsWith('Tool: '))
    expect(toolTraces).toHaveLength(2)

    const traceA = toolTraces.find((t) => t.name === 'Tool: slow_a')!
    const traceB = toolTraces.find((t) => t.name === 'Tool: slow_b')!

    expect(traceA.endTime).not.toBeNull()
    expect(traceB.endTime).not.toBeNull()
    expect(traceA.duration).toBeGreaterThanOrEqual(40)
    expect(traceB.duration).toBeGreaterThanOrEqual(100)
    expect(traceB.endTime!).toBeGreaterThan(traceA.endTime!)

    const toolSpans = exporter.getFinishedSpans().filter((s) => s.name.startsWith('execute_tool '))
    expect(toolSpans).toHaveLength(2)
    const spanA = toolSpans.find((s) => s.name === 'execute_tool slow_a')!
    const spanB = toolSpans.find((s) => s.name === 'execute_tool slow_b')!
    expect(spanA.status.code).toBe(SpanStatusCode.OK)
    expect(spanB.status.code).toBe(SpanStatusCode.OK)
  })

  it('ends both local tool traces accurately when one concurrent tool throws and its sibling succeeds', async () => {
    const exporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    provider.register()

    const agent = new Agent({
      model: createTwoToolsModel('fail_a', 'slow_b'),
      tools: [createDelayedTool('fail_a', 40, { shouldThrow: true }), createDelayedTool('slow_b', 110)],
      printer: false,
    })

    const result = await agent.invoke('Run failing and succeeding tools')

    const cycle1 = result.traces?.[0]
    expect(cycle1).toBeDefined()
    const toolTraces = cycle1!.children.filter((t) => t.name.startsWith('Tool: '))
    expect(toolTraces).toHaveLength(2)

    const traceA = toolTraces.find((t) => t.name === 'Tool: fail_a')!
    const traceB = toolTraces.find((t) => t.name === 'Tool: slow_b')!

    expect(traceA.endTime).not.toBeNull()
    expect(traceB.endTime).not.toBeNull()
    expect(traceA.duration).toBeGreaterThanOrEqual(30)
    expect(traceB.duration).toBeGreaterThanOrEqual(90)
    expect(traceB.endTime!).toBeGreaterThan(traceA.endTime!)
    expect(traceB.duration).toBeGreaterThan(traceA.duration)

    const toolSpans = exporter.getFinishedSpans().filter((s) => s.name.startsWith('execute_tool '))
    expect(toolSpans).toHaveLength(2)
    const spanA = toolSpans.find((s) => s.name === 'execute_tool fail_a')!
    const spanB = toolSpans.find((s) => s.name === 'execute_tool slow_b')!
    expect(spanA.status.code).toBe(SpanStatusCode.ERROR)
    expect(spanB.status.code).toBe(SpanStatusCode.OK)
  })
})
