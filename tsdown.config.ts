import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'index.ts',
  platform: 'node',
  target: 'node22',
  dts: true,
})
