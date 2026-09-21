import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'index.ts',
    'agent-docs': 'src/agent-docs.ts',
  },
  platform: 'node',
  target: 'node22',
  dts: true,
})
