import { Effect, Schema, pipe } from 'effect'

import { PromoRow } from './domain'

const optStr = () => Schema.optional(Schema.Union([Schema.String, Schema.Null]))
const optNum = () => Schema.optional(Schema.Union([Schema.Number, Schema.Null]))

const PromoShape = Schema.Struct({
  id: optStr(),
  service: optStr(),
  subject: optStr(),
  deal: optStr(),
  status: optStr(),
  account: optStr(),
  kind: optStr(),
  expiry: optStr(),
  url: optStr(),
  proof: optStr(),
  notes: optStr(),
  date: optStr(),
  domain: optStr(),
  confidence: optNum(),
})
export type PromoDecoded = typeof PromoShape.Type

export const PromosResponse = Schema.Struct({
  promos: Schema.Array(PromoShape),
  count: Schema.optional(Schema.Number),
})
export type PromosResponse = typeof PromosResponse.Type

const StringCounts = Schema.Record(Schema.String, Schema.Number)

export const StatsResponse = Schema.Struct({
  total: Schema.optional(Schema.Number),
  statuses: Schema.optional(StringCounts),
  accounts: Schema.optional(StringCounts),
  by_kind: Schema.optional(StringCounts),
})
export type StatsResponse = typeof StatsResponse.Type

const str = (value: unknown): string =>
  typeof value === 'string' && value !== '' ? value : ''

const num = (value: unknown): number =>
  typeof value === 'number' ? value : 0

export const normalizeRow = (row: PromoDecoded): PromoRow => ({
  id: str(row.id),
  service: str(row.service),
  subject: str(row.subject),
  deal: str(row.deal),
  status: str(row.status) || 'new',
  account: str(row.account),
  kind: str(row.kind),
  expiry: str(row.expiry),
  url: str(row.url),
  proof: str(row.proof),
  notes: str(row.notes),
  date: str(row.date),
  domain: str(row.domain),
  confidence: num(row.confidence),
})

const decodeSync = <A>(schema: Schema.Schema<A>, value: unknown): A =>
  Schema.decodeUnknownSync(schema as never)(value)

const getJSON = (url: string): Effect.Effect<unknown, string> =>
  Effect.tryPromise({
    try: () =>
      fetch(url).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<unknown>
      }),
    catch: error => (error instanceof Error ? error.message : String(error)),
  })

// Validate the wire shape through the declared schemas (null-tolerant), so the
// rest of the app works with typed data instead of casts.
const decodeJSON = <A>(
  schema: Schema.Schema<A>,
  url: string,
): Effect.Effect<A, string> =>
  pipe(
    getJSON(url),
    Effect.flatMap(json =>
      Effect.try({
        try: () => decodeSync(schema, json),
        catch: error =>
          error instanceof Error ? error.message : String(error),
      }),
    ),
  )

export const fetchPromos: Effect.Effect<PromosResponse, string> = decodeJSON(
  PromosResponse,
  '/api/promos',
)

export const fetchStats: Effect.Effect<StatsResponse, string> = decodeJSON(
  StatsResponse,
  '/api/stats',
)

export const patchPromoStatus = (id: string, status: string): Effect.Effect<unknown, string> =>
  Effect.tryPromise({
    try: () =>
      fetch(`/api/promos/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      }),
    catch: error => (error instanceof Error ? error.message : String(error)),
  })
