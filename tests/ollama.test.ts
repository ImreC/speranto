import { expect, test } from 'vitest'
import { OllamaProvider } from '../src/interface/ollama'

interface MockRequest {
  url: string
  init?: RequestInit
}

function createFetchMock(
  handler: (request: MockRequest) => Response | Promise<Response>,
): {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  requests: MockRequest[]
} {
  const requests: MockRequest[] = []
  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(input), init }
    requests.push(request)
    return handler(request)
  }
  return { fetch: fetchMock, requests }
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

test('OllamaProvider checks the server and installed model', async () => {
  const { fetch, requests } = createFetchMock(({ url }) => {
    if (url.endsWith('/api/version')) return jsonResponse({ version: '1.0.0' })
    if (url.endsWith('/api/tags')) {
      return jsonResponse({ models: [{ name: 'gemma3:latest' }] })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  const provider = new OllamaProvider('gemma3', { fetch })

  await expect(provider.isModelLoaded()).resolves.toBe(true)
  expect(requests.map(({ url }) => url)).toEqual([
    'http://localhost:11434/api/version',
    'http://localhost:11434/api/tags',
  ])
})

test('OllamaProvider reports the pull command when a model is missing', async () => {
  const { fetch } = createFetchMock(({ url }) => {
    if (url.endsWith('/api/version')) return jsonResponse({ version: '1.0.0' })
    return jsonResponse({ models: [] })
  })
  const provider = new OllamaProvider('qwen3:4b', {
    baseUrl: 'http://ollama:11434/v1/',
    fetch,
  })

  await expect(provider.isModelLoaded()).rejects.toThrow(
    'Ollama model "qwen3:4b" is not installed. Run: ollama pull qwen3:4b',
  )
})

test('OllamaProvider can pull a missing model', async () => {
  const { fetch, requests } = createFetchMock(({ url }) => {
    if (url.endsWith('/api/version')) return jsonResponse({ version: '1.0.0' })
    if (url.endsWith('/api/tags')) return jsonResponse({ models: [] })
    if (url.endsWith('/api/pull')) return jsonResponse({ status: 'success' })
    throw new Error(`Unexpected request: ${url}`)
  })
  const provider = new OllamaProvider('qwen3:4b', {
    ollama: { autoPull: true },
    fetch,
  })

  await expect(provider.isModelLoaded()).resolves.toBe(true)
  const pullRequest = requests.find(({ url }) => url.endsWith('/api/pull'))
  expect(JSON.parse(String(pullRequest?.init?.body))).toEqual({
    model: 'qwen3:4b',
    stream: false,
  })
})

test('OllamaProvider uses native JSON output and inference settings', async () => {
  const { fetch, requests } = createFetchMock(() =>
    jsonResponse({
      model: 'gemma3:4b',
      message: { content: '{"title":"Hallo"}' },
      done_reason: 'stop',
      prompt_eval_count: 10,
      eval_count: 4,
    }),
  )
  const provider = new OllamaProvider('gemma3:4b', {
    baseUrl: 'http://ollama:11434/v1',
    apiKey: 'secret',
    ollama: {
      keepAlive: '10m',
      contextLength: 8192,
      temperature: 0.2,
    },
    fetch,
  })

  const response = await provider.generate('Translate this JSON', {
    output: 'json',
    maxTokens: 500,
  })

  expect(response.content).toBe('{"title":"Hallo"}')
  expect(response.usage?.totalTokens).toBe(14)
  const request = requests[0]!
  expect(request.url).toBe('http://ollama:11434/api/chat')
  expect(new Headers(request.init?.headers).get('authorization')).toBe('Bearer secret')
  expect(JSON.parse(String(request.init?.body))).toEqual({
    model: 'gemma3:4b',
    messages: [{ role: 'user', content: 'Translate this JSON' }],
    stream: false,
    format: 'json',
    keep_alive: '10m',
    options: {
      num_predict: 500,
      num_ctx: 8192,
      temperature: 0.2,
    },
  })
})

test('OllamaProvider reports connection failures clearly', async () => {
  const fetchMock = async () => {
    throw new TypeError('fetch failed')
  }
  const provider = new OllamaProvider('gemma3:4b', { fetch: fetchMock })

  await expect(provider.isModelLoaded()).rejects.toThrow(
    'Could not connect to Ollama at http://localhost:11434',
  )
})
