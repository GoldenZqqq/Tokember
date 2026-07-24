import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SITE = resolve(ROOT, 'site')

async function read(relativePath) {
  return readFile(resolve(ROOT, relativePath), 'utf8')
}

function localReferences(html) {
  return [...html.matchAll(/(?:href|src)="(\.\/[^"#?]+)"/g)]
    .map(match => match[1])
}

test('launch site is English-only and contains the public product contract', async () => {
  const html = await read('site/index.html')

  assert.match(html, /<html lang="en">/)
  assert.doesNotMatch(html, /[\u3400-\u9fff]/u)
  assert.match(html, /id="flow"/)
  assert.match(html, /id="privacy"/)
  assert.match(html, /id="film"/)
  assert.match(html, /id="install"/)
  assert.match(html, /<video[^>]+controls[^>]+playsinline[^>]+preload="metadata"/)
  assert.match(html, /tokember-launch-film\.webm[^>]+video\/webm/)
  assert.match(html, /tokember-launch-film\.mp4[^>]+video\/mp4/)
  assert.match(html, /poster="\.\/assets\/tokember-launch-film-poster\.jpg"/)
  assert.match(html, /https:\/\/github\.com\/GoldenZqqq\/Tokember/)
  assert.match(html, /git clone https:\/\/github\.com\/GoldenZqqq\/Tokember\.git/)
  assert.doesNotMatch(html, /\.trellis|deploy\.yml|TOKEMBER_(?:API_KEY|ADMIN_PASSWORD)/)
})

test('README links to the canonical GitHub Pages site', async () => {
  const readme = await read('README.md')

  assert.match(
    readme,
    /\[goldenzqqq\.github\.io\/Tokember\]\(https:\/\/goldenzqqq\.github\.io\/Tokember\/\)/,
  )
})

test('launch site uses repository-subpath-safe local references with real assets', async () => {
  const html = await read('site/index.html')
  const references = localReferences(html)

  assert.ok(references.length >= 6)
  assert.doesNotMatch(html, /(?:href|src)="\/(?!\/)/)
  for (const reference of references) {
    const target = resolve(SITE, reference)
    assert.ok(target.startsWith(`${SITE}${sep}`))
    await access(target)
  }
})

test('launch site keeps motion optional and the canvas-only Hero accessible', async () => {
  const [html, css, script, furnace] = await Promise.all([
    read('site/index.html'),
    read('site/styles.css'),
    read('site/main.js'),
    read('site/furnace-core.js'),
  ])

  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /\.furnace-canvas\s*\{\s*display:\s*none;/)
  assert.match(script, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/)
  assert.match(furnace, /prefers-reduced-motion/)
  assert.match(furnace, /tokember-core\.glb/)
  assert.match(furnace, /wrapMotionParts/)
  assert.match(furnace, /createEmberField/)
  assert.match(furnace, /resolveCoreQuality/)
  assert.match(furnace, /pointerenter/)
  assert.match(furnace, /pointerType === 'touch'/)
  assert.match(furnace, /dataset\.coreState/)
  assert.match(html, /furnace-core\.js/)
  assert.match(html, /tokember-core\.glb/)
  assert.doesNotMatch(html, /furnace-fallback/)
  assert.match(html, /id="furnace-status"[^>]+role="status"/)
  assert.match(html, /data-model-state="loading"/)
  assert.match(html, /data-core-state="compact"/)
  assert.match(html, /tabindex="0" role="img"/)
  assert.match(html, /<canvas[^>]+aria-hidden="true"/)
  assert.doesNotMatch(html, /<video[^>]+autoplay/)
  assert.doesNotMatch(html, /(?:hidden|aria-hidden="true")[^>]*>\s*(?:<[^>]+>\s*)*(?:Tokember|Install)/)
})

test('Pages workflow deploys only the static site through GitHub Pages', async () => {
  const workflow = await read('.github/workflows/pages.yml')

  assert.match(workflow, /^name:\s*Pages\s*$/m)
  assert.match(workflow, /if:\s*github\.repository == 'GoldenZqqq\/Tokember'/)
  assert.match(workflow, /actions\/configure-pages@v5/)
  assert.match(workflow, /actions\/upload-pages-artifact@v3/)
  assert.match(workflow, /path:\s*site/)
  assert.match(workflow, /actions\/deploy-pages@v4/)
  assert.match(workflow, /pages:\s*write/)
  assert.match(workflow, /id-token:\s*write/)
  assert.doesNotMatch(workflow, /deploy\.yml|DEPLOY_HOST|appleboy|TOKEMBER_/)
})
