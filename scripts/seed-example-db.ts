import initSqlJs from 'sql.js'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dbPath = resolve(import.meta.dirname, '../example_content/example.db')

const SQL = await initSqlJs()
const db = new SQL.Database()

db.run(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'en'
  )
`)

db.run(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL
  )
`)

const articles = [
  {
    title: 'Getting Started with Internationalization',
    summary: 'A practical guide to making your web application accessible to users around the world.',
    body: 'Internationalization (i18n) is the process of designing your application so it can be adapted to various languages and regions without engineering changes. This involves externalizing strings, handling date and number formats, and supporting right-to-left languages.',
    lang: 'en',
  },
  {
    title: 'Les meilleures pratiques pour la traduction automatique',
    summary: "Comment tirer le meilleur parti des outils de traduction automatique pour votre projet.",
    body: "La traduction automatique a fait d'énormes progrès ces dernières années. Pour obtenir les meilleurs résultats, il est important de fournir un contexte clair, d'utiliser des phrases courtes et de toujours relire les traductions.",
    lang: 'fr',
  },
]

for (const article of articles) {
  db.run(
    'INSERT INTO articles (title, summary, body, lang) VALUES (?, ?, ?, ?)',
    [article.title, article.summary, article.body, article.lang],
  )
}

const products = [
  {
    name: 'Translation Memory Plugin',
    description: 'A powerful plugin that stores previously translated segments to ensure consistency across your project and speed up future translations.',
  },
  {
    name: 'Glossary Manager',
    description: 'Define and manage terminology glossaries to keep translations consistent. Supports import and export in standard TBX format.',
  },
  {
    name: 'Quality Assurance Toolkit',
    description: 'Automatically detect common translation errors such as missing placeholders, inconsistent terminology, and untranslated segments.',
  },
]

for (const product of products) {
  db.run(
    'INSERT INTO products (name, description) VALUES (?, ?)',
    [product.name, product.description],
  )
}

writeFileSync(dbPath, Buffer.from(db.export()))
db.close()

console.log(`Example database created at ${dbPath}`)
console.log('  - articles: 2 rows (1 English, 1 French)')
console.log('  - products: 3 rows')
