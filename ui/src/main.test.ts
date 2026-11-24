import { describe, expect, it } from 'vitest'
import { AsyncData } from 'foldkit'
import { DragAndDrop } from '@foldkit/ui'
import { Effect, HashMap, Option } from 'effect'

const exitOk = <A>(value: A): never =>
  Effect.runSync(Effect.succeed(value)) as never

import { Model, init, update } from './main'
import { Message } from './message'
import { PromoRow, STATUSES, nextStatus } from './domain'
import { normalizeRow } from './data'

const row = (overrides: Partial<PromoRow>): PromoRow => ({
  id: 'r1',
  service: 'Test',
  subject: 'Subj',
  deal: 'Deal',
  status: 'new',
  account: 'user1@example.com',
  kind: 'promo_confirm',
  expiry: '',
  url: '',
  proof: '',
  notes: '',
  date: '',
  domain: '',
  confidence: 1,
  ...overrides,
})

const baseModel = () => ({
  promos: AsyncData.succeed({ promos: [row({ id: 'a' }), row({ id: 'b', status: 'live' })], count: 2 }),
  stats: AsyncData.succeed({ total: 2, statuses: { new: 1, live: 1 }, accounts: {}, by_kind: {} }),
  q: '',
  maybeStatusFilter: Option.none(),
  patchingIds: HashMap.empty(),
  dragAndDrop: DragAndDrop.init({ id: 'test-board', orientation: 'Vertical' }),
})

describe('domain status cycle', () => {
  it('cycles new → pending → live → blocked → new', () => {
    expect(nextStatus('new')).toBe('pending')
    expect(nextStatus('pending')).toBe('live')
    expect(nextStatus('live')).toBe('blocked')
    expect(nextStatus('blocked')).toBe('new')
    expect(STATUSES).toHaveLength(4)
  })
})

describe('normalizeRow', () => {
  it('defaults null/absent fields', () => {
    const n = normalizeRow({ id: null, service: null, status: null, account: null, confidence: null } as never)
    expect(n.id).toBe('')
    expect(n.service).toBe('')
    expect(n.status).toBe('new')
    expect(n.account).toBe('')
    expect(n.confidence).toBe(0)
  })
})

describe('update', () => {
  it('init issues fetch commands', () => {
    const result = init()
    expect(result.model.q).toBe('')
    expect(result.commands).toHaveLength(2)
  })

  it('ClickedSearch updates the query', () => {
    const next = update(baseModel(), Message.ClickedSearch({ value: 'gemini' }))
    expect(next.model.q).toBe('gemini')
  })

  it('ClickedStatusFilter stores the selected status as Option', () => {
    const next = update(baseModel(), Message.ClickedStatusFilter({ status: Option.some('live') }))
    expect(Option.isSome(next.model.maybeStatusFilter)).toBe(true)
    expect(Option.getOrElse(next.model.maybeStatusFilter, () => '')).toBe('live')
  })

  it('ClickedCycleStatus dispatches a PatchStatus command and marks the row', () => {
    const next = update(baseModel(), Message.ClickedCycleStatus({ id: 'a', next: 'pending' }))
    expect(next.commands).toHaveLength(1)
    expect(HashMap.has(next.model.patchingIds, 'a')).toBe(true)
  })

  it('SettledPatchStatus clears the pending mark and refetches', () => {
    const withPatch = update(baseModel(), Message.ClickedCycleStatus({ id: 'a', next: 'pending' }))
    const settled = update(
      withPatch.model,
      { _tag: 'SettledPatchStatus', id: 'a', result: exitOk({ ok: true }) } as never,
    )
    expect(HashMap.has(settled.model.patchingIds, 'a')).toBe(false)
    expect(settled.commands).toHaveLength(2)
  })

  it('SettledFetchPromos lands rows in AsyncData', () => {
    const payload = { promos: [row({})], count: 1 }
    const next = update(
      baseModel(),
      { _tag: 'SettledFetchPromos', result: exitOk(payload) } as never,
    )
    expect(AsyncData.isSuccess(next.model.promos)).toBe(true)
  })
})
