import { Schema } from 'effect'
import { DragAndDrop } from '@foldkit/ui'
import { defineMessageUnion } from 'foldkit/message'

import { PromosResponse, StatsResponse } from './data'

export const Message = defineMessageUnion({
  SettledFetchPromos: { result: Schema.Result(PromosResponse, Schema.String) },
  SettledFetchStats: { result: Schema.Result(StatsResponse, Schema.String) },
  ClickedRefresh: {},
  ClickedSearch: { value: Schema.String },
  ClickedStatusFilter: { status: Schema.Option(Schema.String) },
  ClickedCycleStatus: { id: Schema.String, next: Schema.String },
  SettledPatchStatus: {
    id: Schema.String,
    result: Schema.Result(Schema.Unknown, Schema.String),
  },
  GotDragAndDropMessage: { message: DragAndDrop.Message },
})
export type Message = typeof Message.Type
