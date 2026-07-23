import { expect, test } from '@playwright/test'

const boundedSelectors = [
  'h1', 'h2', '.button', '.telemetry-rail', '.privacy-cutaway', '.film-frame', '.command-block',
]

test('renders a complete, bounded launch experience @site-screenshot', async ({ page }, testInfo) => {
  const browserErrors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => browserErrors.push(`page: ${error.message}`))
  page.on('requestfailed', request => {
    const isOptionalWebm = request.resourceType() === 'media' && request.url().endsWith('/tokember-launch-film.webm')
    if (!isOptionalWebm) browserErrors.push(`request: ${request.url()}`)
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tokember', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Light the first ember.' })).toBeVisible()

  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  const geometry = await page.evaluate(selectors => {
    const bounds = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
      .map(element => {
        const rect = element.getBoundingClientRect()
        return { selector: element.className || element.tagName, left: rect.left, right: rect.right }
      })
    return {
      bounds,
      documentWidth: document.documentElement.scrollWidth,
      flowTop: document.querySelector('#flow')?.getBoundingClientRect().top ?? Infinity,
    }
  }, boundedSelectors)
  expect(geometry.documentWidth).toBeLessThanOrEqual(viewport!.width + 1)
  expect(geometry.flowTop).toBeLessThanOrEqual(viewport!.height)
  for (const bounds of geometry.bounds) {
    expect(bounds.left, `${bounds.selector} crosses the left viewport edge`).toBeGreaterThanOrEqual(-1)
    expect(bounds.right, `${bounds.selector} crosses the right viewport edge`).toBeLessThanOrEqual(viewport!.width + 1)
  }

  await expect.poll(() => page.locator('img').evaluateAll(images => images.every(image => {
    const element = image as HTMLImageElement
    return element.complete && element.naturalWidth > 0
  }))).toBe(true)
  const film = page.locator('.film-player')
  await expect(film).toBeVisible()
  await expect.poll(() => film.evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
  const filmMetadata = await film.evaluate(video => {
    const player = video as HTMLVideoElement
    return { duration: player.duration, width: player.videoWidth, height: player.videoHeight, paused: player.paused }
  })
  expect(filmMetadata.duration).toBeGreaterThan(41.9)
  expect(filmMetadata.duration).toBeLessThan(42.2)
  expect(filmMetadata.width).toBe(1920)
  expect(filmMetadata.height).toBe(1080)
  expect(filmMetadata.paused).toBe(true)
  const filmCopyWidth = await page.locator('.film-copy > p:last-child').evaluate(element => {
    return element.getBoundingClientRect().width
  })
  expect(filmCopyWidth).toBeGreaterThanOrEqual(Math.min(260, viewport!.width - 28))

  await page.locator('#install').scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: 'Copy install command' }).focus()
  await expect(page.getByRole('button', { name: 'Copy install command' })).toBeFocused()

  if (testInfo.project.name === 'mobile-320') {
    const heroCopy = await page.locator('.hero-copy').boundingBox()
    const telemetry = await page.locator('.telemetry-rail').boundingBox()
    expect(heroCopy).not.toBeNull()
    expect(telemetry).not.toBeNull()
    expect(heroCopy!.y + heroCopy!.height).toBeLessThanOrEqual(telemetry!.y)
    await expect(page.locator('.core-readout')).toBeHidden()
    const menu = page.locator('.mobile-nav summary')
    const menuBounds = await menu.boundingBox()
    expect(menuBounds!.width).toBeGreaterThanOrEqual(44)
    expect(menuBounds!.height).toBeGreaterThanOrEqual(44)
    await menu.click()
    await expect(page.locator('.mobile-nav').getByRole('link', { name: 'Privacy' })).toBeVisible()
    await menu.click()
  }

  await page.screenshot({ path: testInfo.outputPath('tokember-site.png'), fullPage: true })
  expect(browserErrors).toEqual([])
})

test('renders a nonblank furnace and honors reduced motion', async ({ page }) => {
  await page.goto('/')
  await page.waitForTimeout(150)
  const litPixels = await page.locator('#furnace-canvas').evaluate(canvas => {
    const element = canvas as HTMLCanvasElement
    const context = element.getContext('2d')
    if (!context) return 0
    const pixels = context.getImageData(0, 0, element.width, element.height).data
    let count = 0
    for (let index = 3; index < pixels.length; index += 64) {
      if (pixels[index] > 8) count += 1
    }
    return count
  })
  expect(litPixels).toBeGreaterThan(20)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('#furnace-canvas')).toHaveCSS('display', 'none')
  await expect(page.locator('#furnace-stage')).toHaveAttribute('data-flame-state', 'procedural')
  const duration = await page.locator('.core-orbit-a').evaluate(element => {
    return Number.parseFloat(getComputedStyle(element).animationDuration)
  })
  expect(duration).toBeLessThanOrEqual(0.000001)
})

test('furnace core reveals on hover, focus, and tap', async ({ page }, testInfo) => {
  await page.goto('/')
  const stage = page.locator('#furnace-stage')
  await expect(stage).toHaveAttribute('data-core-state', 'compact')
  await expect(stage).toHaveClass(/is-live/)
  await expect(stage).toHaveAttribute('data-shell-pose', 'enclosing')
  await expect(stage).toHaveAttribute('data-core-quality', /full|lite/)
  await expect(page.locator('.furnace-fallback')).toHaveCount(0)
  await stage.screenshot({ path: testInfo.outputPath('furnace-compact.png') })

  if (testInfo.project.name === 'mobile-320') {
    const stageOwnsItsCenter = await stage.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      return target === element || element.contains(target)
    })
    expect(stageOwnsItsCenter).toBe(true)
    await stage.dispatchEvent('pointerenter', { pointerType: 'touch' })
    await expect(stage).toHaveAttribute('data-core-state', 'compact')
  } else {
    await stage.hover()
    await expect(stage).toHaveAttribute('data-core-state', 'revealed')
    await stage.screenshot({ path: testInfo.outputPath('furnace-revealed.png') })
    await page.mouse.move(1, 1)
    await expect(stage).toHaveAttribute('data-core-state', 'compact')
  }

  await stage.focus()
  await expect(stage).toHaveAttribute('data-core-state', 'revealed')
  await page.locator('.brand').focus()
  await expect(stage).toHaveAttribute('data-core-state', 'compact')

  await stage.dispatchEvent('click', { detail: 1 })
  await expect(stage).toHaveAttribute('data-core-state', 'revealed')
  await stage.dispatchEvent('click', { detail: 1 })
  await expect(stage).toHaveAttribute('data-core-state', 'compact')
})

test('procedural flame changes rendered pixels while motion is enabled', async ({ page }) => {
  await page.goto('/')
  const stage = page.locator('#furnace-stage')
  await expect(stage).toHaveClass(/is-live/)
  await expect(stage).toHaveAttribute('data-flame-state', 'procedural')
  const first = await stage.screenshot()
  await page.waitForTimeout(240)
  const second = await stage.screenshot()
  expect(first.equals(second)).toBe(false)
})
