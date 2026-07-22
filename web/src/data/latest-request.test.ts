import assert from 'node:assert/strict'
import test from 'node:test'
import { LatestRequest } from './latest-request'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test('device, range or year switches only commit the latest request', async () => {
  const controller = new LatestRequest()
  const first = deferred<string>()
  const second = deferred<string>()
  const oldRun = controller.execute(() => first.promise)
  const newRun = controller.execute(() => second.promise)

  second.resolve('new')
  assert.deepEqual(await newRun, { current: true, value: 'new' })
  first.resolve('old')
  assert.deepEqual(await oldRun, { current: false })
})

test('replaced request rejection is suppressed as non-current', async () => {
  const controller = new LatestRequest()
  const first = deferred<string>()
  const oldRun = controller.execute(() => first.promise)
  const newRun = controller.execute(async () => 'new')
  assert.equal((await newRun).current, true)
  first.reject(new Error('late failure'))
  assert.equal((await oldRun).current, false)
})
