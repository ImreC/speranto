export default {
  model: 'mistral-large-latest',
  temperature: 0.0,
  sourceLang: 'en',
  targetLangs: ['nl'],
  sourceDir: './content/blog/en',
  targetDir: './content/blog/[lang]',
  provider: 'mistral',
}
