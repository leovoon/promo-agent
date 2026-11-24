import { Effect, Schema, pipe } from 'effect'
import { Command } from 'foldkit'

import { fetchPromos, fetchStats, patchPromoStatus } from './data'
import { Message } from './message'

export const FetchPromos = Command.define('FetchPromos', {
  messages: [Message.SettledFetchPromos],
  execute: pipe(
    fetchPromos,
    Effect.result,
    Effect.map(result => Message.SettledFetchPromos({ result })),
  ),
})

export const FetchStats = Command.define('FetchStats', {
  messages: [Message.SettledFetchStats],
  execute: pipe(
    fetchStats,
    Effect.result,
    Effect.map(result => Message.SettledFetchStats({ result })),
  ),
})

export const PatchStatus = Command.define('PatchStatus', {
  args: { id: Schema.String, next: Schema.String },
  messages: [Message.SettledPatchStatus],
  execute: ({ id, next }) =>
    pipe(
      patchPromoStatus(id, next),
      Effect.result,
      Effect.map(result => Message.SettledPatchStatus({ id, result })),
    ),
})
