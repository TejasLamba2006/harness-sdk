import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../../tools/tool.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { JSONValue } from '../../../types/json.js'
import { httpRequest } from '../http-request.js'

function createToolContext(input: JSONValue, cancelSignal?: AbortSignal): ToolContext {
  const controller = new AbortController()
  return {
    toolUse: {
      name: 'http_request',
      toolUseId: 'test-http-timeout',
      input,
    },
    agent: { cancelSignal: controller.signal } as LocalAgent,
    invocationState: {},
    cancelSignal: cancelSignal ?? controller.signal,
    interrupt: vi.fn() as ToolContext['interrupt'],
  }
}

describe('httpRequest tool (Node integration)', () => {
  let server: http.Server
  let baseUrl: string

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/slow') {
        // Intentionally hang before sending headers
        return
      }
      if (req.url === '/slow-body') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.write('partial')
        // Intentionally hang before ending response body
        return
      }
      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('returns formatted timeout error ToolResult when a real request times out waiting for headers', async () => {
    const url = `${baseUrl}/slow`
    const context = createToolContext({ method: 'GET', url, timeout: 0.2 })

    const generator = httpRequest.stream(context)
    let next = await generator.next()
    while (!next.done) {
      next = await generator.next()
    }
    const result = next.value

    expect(result.status).toBe('error')
    expect(JSON.parse(JSON.stringify(result.content))).toEqual([
      { text: `Error: Request timed out after 0.2 seconds: GET ${url}` },
    ])
  })

  it('throws formatted timeout error when a real response times out mid-body', async () => {
    const url = `${baseUrl}/slow-body`

    await expect(
      httpRequest.invoke({
        method: 'GET',
        url,
        timeout: 0.2,
      })
    ).rejects.toThrow(`Request timed out after 0.2 seconds: GET ${url}`)
  })

  it('throws cancelled error when cancelSignal aborts a real hanging request before timeout', async () => {
    const url = `${baseUrl}/slow`
    const controller = new AbortController()
    const context = createToolContext({ method: 'GET', url, timeout: 5 }, controller.signal)

    const timer = globalThis.setTimeout(() => controller.abort(), 50)
    try {
      await expect(
        httpRequest.invoke(
          {
            method: 'GET',
            url,
            timeout: 5,
          },
          context
        )
      ).rejects.toThrow(`Request cancelled: GET ${url}`)
    } finally {
      globalThis.clearTimeout(timer)
    }
  })
})
