import { Array, HashMap, Option, Schema } from 'effect'
import { AsyncData, Runtime, Subscription, Update } from 'foldkit'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'
import { Button, DragAndDrop, Input } from '@foldkit/ui'

import { FetchPromos, FetchStats, PatchStatus } from './command'
import { PromoRow, STATUSES, nextStatus, statusLabel } from './domain'
import { Message } from './message'
import { PromosResponse, StatsResponse, normalizeRow } from './data'

// MODEL

export const PromosData = AsyncData.Schema(Schema.Any, Schema.String)
export const StatsData = AsyncData.Schema(Schema.Any, Schema.String)

export const Model = Schema.Struct({
  promos: PromosData.schema,
  stats: StatsData.schema,
  q: Schema.String,
  maybeStatusFilter: Schema.Option(Schema.String),
  patchingIds: Schema.HashMap(Schema.String, Schema.Boolean),
  dragAndDrop: DragAndDrop.Model,
})
export type Model = typeof Model.Type

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const foldDragAndDropOutMessage = DragAndDrop.OutMessage.match<
  Update.Step<Model, Message>
>({
  Reordered: ({ itemId, fromContainerId, toContainerId }) => model => {
    const maybeNextStatus =
      fromContainerId === toContainerId
        ? Option.none()
        : Option.some(toContainerId)

    return {
      model: modifyFields(model, { patchingIds: HashMap.set(itemId, true) }),
      commands: Array.fromOption(
        Option.map(maybeNextStatus, next => PatchStatus({ id: itemId, next })),
      ),
    }
  },
  Cancelled: () => model => ({ model }),
})

const foldDragAndDrop = Update.foldChild({
  update: DragAndDrop.update,
  read: (model: Model) => Option.some(model.dragAndDrop),
  write: (model, nextDragAndDrop) =>
    modifyFields(model, { dragAndDrop: () => nextDragAndDrop }),
  toParentMessage: message => Message.GotDragAndDropMessage({ message }),
  foldOutMessage: foldDragAndDropOutMessage,
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SettledFetchPromos: ({ result }) => ({
      model: modifyFields(model, {
        promos: AsyncData.settle(result),
      }),
    }),

    SettledFetchStats: ({ result }) => ({
      model: modifyFields(model, {
        stats: AsyncData.settle(result),
      }),
    }),

    ClickedRefresh: () => ({
      model,
      commands: [FetchPromos(), FetchStats()],
    }),

    ClickedSearch: ({ value }) => ({
      model: modifyFields(model, { q: () => value }),
    }),

    ClickedStatusFilter: ({ status }) => ({
      model: modifyFields(model, { maybeStatusFilter: () => status }),
    }),

    ClickedCycleStatus: ({ id, next }) => ({
      model: modifyFields(model, { patchingIds: HashMap.set(id, true) }),
      commands: [PatchStatus({ id, next })],
    }),

    SettledPatchStatus: ({ id }) => ({
      model: modifyFields(model, { patchingIds: HashMap.remove(id) }),
      commands: [FetchPromos(), FetchStats()],
    }),

    GotDragAndDropMessage: ({ message }) => foldDragAndDrop(model, message),
  })

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    promos: PromosData.Loading(),
    stats: StatsData.Loading(),
    q: '',
    maybeStatusFilter: Option.none(),
    patchingIds: HashMap.empty(),
    dragAndDrop: DragAndDrop.init({ id: 'promo-kanban', orientation: 'Vertical' }),
  },
  commands: [FetchPromos(), FetchStats()],
})

export const subscriptions = Subscription.lift({
  dragPointer: DragAndDrop.subscriptions.documentPointer,
  dragEscape: DragAndDrop.subscriptions.documentEscape,
  dragKeyboard: DragAndDrop.subscriptions.documentKeyboard,
  autoScroll: DragAndDrop.subscriptions.autoScroll,
})<Model, Message>({
  read: model => Option.some(model.dragAndDrop),
  toParentMessage: message => Message.GotDragAndDropMessage({ message }),
})

// VIEW

const filterRows = (
  rows: ReadonlyArray<PromoRow>,
  q: string,
  maybeStatusFilter: Option.Option<string>,
): ReadonlyArray<PromoRow> => {
  const query = q.trim().toLowerCase()
  const filterStatus = Option.getOrElse(maybeStatusFilter, () => '')

  return Array.filter(rows, row => {
    if (filterStatus !== '' && row.status !== filterStatus) return false
    if (query === '') return true

    const haystack =
      `${row.service} ${row.subject} ${row.deal} ${row.account} ${row.domain}`.toLowerCase()
    return haystack.includes(query)
  })
}

const groupByStatus = (
  rows: ReadonlyArray<PromoRow>,
): ReadonlyArray<{ status: string; rows: ReadonlyArray<PromoRow> }> =>
  STATUSES.map(status => ({
    status,
    rows: Array.filter(rows, row => row.status === status),
  }))

const nextAction = (
  rows: ReadonlyArray<PromoRow>,
): PromoRow | null => {
  const actionable = Array.filter(
    rows,
    row => row.status === 'live' || row.status === 'pending',
  )
  const withExpiry = Array.filter(actionable, row => row.expiry !== '').sort(
    (a, b) => a.expiry.localeCompare(b.expiry),
  )
  return withExpiry[0] ?? actionable[0] ?? null
}

const pick = (value: string): string =>
  value === '' || value === null ? '—' : value

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Promo Ledger',
  body: h.div(
    [h.Class('page')],
    [
      headerView(model, h),
      statsView(model, h),
      controlsView(model, h),
      listView(model, h),
      h.footer(
        [h.Class('footer-note')],
        ['Built with Foldkit — Model-as-truth, Elm architecture.'],
      ),
    ],
  ),
})

const headerView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const busy = AsyncData.isPending(model.promos) || AsyncData.isPending(model.stats)

  return h.header([h.Class('header')], [
    h.div([h.Class('title')], [
      h.h1([], ['Promo Ledger']),
      h.p([], ['Free plans & promos my agent found — triaged, logged, and never forgotten.']),
    ]),
    Button.view(
      {
        onClick: Message.ClickedRefresh(),
        isDisabled: busy,
        toView: attributes =>
          h.button(
            [...attributes.button, h.Class('btn')],
            [busy ? 'Refreshing…' : 'Refresh'],
          ),
      },
      h,
    ),
  ])
}

const statsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.matchDataSplitEmpty(model.stats, {
    onIdle: () => h.empty,
    onLoading: () => h.empty,
    onFailure: () => h.empty,
    onData: stats => {
      // NOTE: AsyncData models payloads as Any (they tolerate null-bearing rows);
      // narrow to the decoded StatsResponse after settle.
      const s = stats as unknown as StatsResponse
      return h.div([h.Class('stats')], [
        statCard('Total offers', String(s.total ?? 0), h),
        ...STATUSES.map(status =>
          statCard(statusLabel(status), String(s.statuses?.[status] ?? 0), h),
        ),
        statCard('Accounts', String(Object.keys(s.accounts ?? {}).length), h),
      ])
    },
  })

const statCard = (label: string, value: string, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('stat')], [
    h.div([h.Class('label')], [label]),
    h.div([h.Class('value')], [value]),
  ])

const controlsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('controls')], [
    Input.view(
      {
        id: 'promo-search',
        value: model.q,
        onInput: value => Message.ClickedSearch({ value }),
        placeholder: 'Search service, subject, deal, account…',
        type: 'text',
        toView: attributes =>
          h.input([...attributes.input, h.Class('search')]),
      },
      h,
    ),
    h.div([h.Class('chips')], [
      chip('All', Option.none(), model, h),
      ...STATUSES.map(status => chip(statusLabel(status), Option.some(status), model, h)),
    ]),
  ])

const chip = (
  label: string,
  value: Option.Option<string>,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const active = Option.isSome(value) && Option.isSome(model.maybeStatusFilter)
    ? Option.getOrElse(value, () => '') === Option.getOrElse(model.maybeStatusFilter, () => '')
    : Option.isNone(value) && Option.isNone(model.maybeStatusFilter)

  const count = AsyncData.matchDataSplitEmpty(model.stats, {
    onIdle: () => '',
    onLoading: () => '',
    onFailure: () => '',
    onData: stats => {
      const s = stats as unknown as StatsResponse
      return Option.isNone(value)
        ? String(s.total ?? 0)
        : String(s.statuses?.[Option.getOrElse(value, () => '')] ?? 0)
    },
  })

  return Button.view(
    {
      onClick: Message.ClickedStatusFilter({ status: value }),
      toView: attributes =>
        h.button(
          [
            ...attributes.button,
            h.Class(`chip${active ? ' active' : ''}`),
            h.AriaPressed(active ? 'true' : 'false'),
          ],
          [label, h.span([h.Class('count')], [count])],
        ),
    },
    h,
  )
}

const listView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.matchDataSplitEmpty(model.promos, {
    onIdle: () => stateBanner('Loading…', false, h),
    onLoading: () => stateBanner('Loading offers…', false, h),
    onFailure: error =>
      stateBanner(`Failed to load: ${error}`, true, h),
    onData: promos => {
      // NOTE: see statsView — AsyncData payloads are Any; rows are normalized after settle.
      const res = promos as unknown as PromosResponse
      const rows = filterRows(
        res.promos.map(normalizeRow),
        model.q,
        model.maybeStatusFilter,
      )

      if (rows.length === 0) {
        return stateBanner('No offers match that filter.', false, h)
      }

      const action = nextAction(rows)
      const columns = groupByStatus(rows)
      const dragging = DragAndDrop.isDragging(model.dragAndDrop)
      const draggedId = Option.getOrElse(
        DragAndDrop.maybeDraggedItemId(model.dragAndDrop),
        () => '',
      )

      return h.div([h.Class('kanban')], [
        ...(action ? [insightView(action, h)] : []),
        h.div([h.Class(`board${dragging ? ' dragging' : ''}`)], [
          ...columns.map(column =>
            columnView(column.status, column.rows, model, h, dragging, draggedId),
          ),
        ]),
        ghostElement(rows, draggedId, model, h),
      ])
    },
  })

const rowKey = (row: PromoRow, index: number): string =>
  row.id !== '' ? row.id : `${row.service}-${index}`

// The carried card rendered as a fixed ghost that follows the pointer.
// Mirrors the kanban exemplar: ghostStyle(model) -> Option<CSSProperties>.
const findDraggedRow = (
  rows: ReadonlyArray<PromoRow>,
  draggedId: string,
): PromoRow | null =>
  Option.getOrElse(
    Array.findFirst(rows, row => row.id === draggedId),
    () => null,
  )

const ghostElement = (
  rows: ReadonlyArray<PromoRow>,
  draggedId: string,
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(
    Option.flatMap(
      DragAndDrop.ghostStyle(model.dragAndDrop),
      ghostStyle => {
        const row = findDraggedRow(rows, draggedId)
        return row === null
          ? Option.none<{ ghostStyle: object; row: PromoRow }>()
          : Option.some({ ghostStyle, row })
      },
    ),
    {
      onNone: () => h.empty,
      onSome: ({ ghostStyle, row }) =>
        h.div(
          [
            h.Style(ghostStyle as unknown as Record<string, string>),
            h.Class('card ghost'),
            h.AriaHidden(true),
          ],
          [rowMain(row, h)],
        ),
    },
  )

const dropPlaceholder = (
  row: PromoRow | null,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')('drop-placeholder', [
    h.Class('drop-placeholder'),
    h.AriaHidden(true),
  ], row === null ? [] : [h.div([h.Class('slot-inner')], [rowMain(row, h)])])

const cardElement = (
  row: PromoRow,
  index: number,
  status: string,
  model: Model,
  h: HtmlBuilder<Message>,
  dragging: boolean,
  draggedId: string,
): Html =>
  h.keyed('li')(
    rowKey(row, index),
    [
      ...DragAndDrop.draggable(
        {
          model: model.dragAndDrop,
          toParentMessage: message =>
            Message.GotDragAndDropMessage({ message }),
          itemId: row.id,
          containerId: status,
          index,
        },
        h,
      ),
      h.Class(
        `card${dragging && row.id === draggedId ? ' is-source' : ''}`,
      ),
    ],
    [
      rowMain(row, h),
      rowActions(row, model, h),
    ],
  )

const columnView = (
  status: string,
  rows: ReadonlyArray<PromoRow>,
  model: Model,
  h: HtmlBuilder<Message>,
  dragging: boolean,
  draggedId: string,
): Html => {
  const isPointerDrag = model.dragAndDrop.dragState._tag === 'Dragging'
  const maybeTarget = DragAndDrop.maybeDropTarget(model.dragAndDrop)
  const isDropTarget =
    dragging && Option.exists(maybeTarget, target => target.containerId === status)

  const cardList = (): Html => {
    if (!dragging) {
      return rows.length > 0
        ? h.ul(
            [
              ...DragAndDrop.droppable(status, `${statusLabel(status)} offers`),
              h.Class('cards'),
            ],
            Array.map(rows, (row, index) =>
              cardElement(row, index, status, model, h, dragging, draggedId),
            ),
          )
        : h.div([h.Class('column-empty')], ['No offers'])
    }

    const visibleRows = Array.filter(rows, row => row.id !== draggedId)
    const elements = Array.map(visibleRows, (row, index) =>
      cardElement(row, index, status, model, h, dragging, draggedId),
    )

    if (!isDropTarget) {
      if (rows.length === 0) {
        return h.div([h.Class('column-empty')], ['No offers'])
      }
      return h.ul(
        [
          ...DragAndDrop.droppable(status, `${statusLabel(status)} offers`),
          h.Class('cards'),
        ],
        elements,
      )
    }

    const targetIndex = Option.match(maybeTarget, {
      onNone: () => visibleRows.length,
      onSome: target => Math.min(target.index, visibleRows.length),
    })

    // Pointer drag: show a placeholder at the exact insertion index. Keyboard
    // drag: show the carried card itself in its live target slot.
    const draggedRow = Option.getOrElse(
      Array.findFirst(rows, row => row.id === draggedId),
      () => null,
    )

    const insertElement = isPointerDrag
      ? dropPlaceholder(draggedRow, h)
      : Option.match(
          Array.findFirst(rows, row => row.id === draggedId),
          {
            onNone: () => dropPlaceholder(null, h),
            onSome: row => cardElement(row, targetIndex, status, model, h, dragging, draggedId),
          },
        )

    const withInsert = Option.getOrElse(
      Array.insertAt(elements, targetIndex, insertElement),
      () => [...elements, insertElement],
    )

    return h.ul(
      [
        ...DragAndDrop.droppable(status, `${statusLabel(status)} offers`),
        h.Class('cards'),
      ],
      withInsert,
    )
  }

  return h.div([h.Class(`column${isDropTarget ? ' drop-target' : ''}`)], [
    h.div([h.Class('column-head')], [
      h.span([h.Class(`dot st-${status}`)], []),
      h.h2([h.Class('column-title')], [statusLabel(status)]),
      h.span([h.Class('column-count')], [String(rows.length)]),
    ]),
    cardList(),
  ])
}

const rowMain = (row: PromoRow, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('row-main')], [
    h.div([h.Class('row-service')], [pick(row.service)]),
    h.div([h.Class('row-subject')], [pick(row.subject)]),
    h.div([h.Class('row-deal')], [pick(row.deal)]),
    h.div([h.Class('row-meta')], [
      h.span([h.Class(`badge st-${row.status}`)], [statusLabel(row.status)]),
      row.account ? h.span([], [row.account]) : h.empty,
      row.expiry ? h.span([], [`expires ${row.expiry}`]) : h.empty,
      row.kind ? h.span([], [row.kind]) : h.empty,
      row.date ? h.span([], [row.date]) : h.empty,
      row.domain ? h.span([], [row.domain]) : h.empty,
    ]),
  ])

const insightView = (row: PromoRow, h: HtmlBuilder<Message>): Html => {
  const text =
    row.expiry !== ''
      ? `${pick(row.service)} — expires ${row.expiry}`
      : `${pick(row.service)} — ${statusLabel(row.status)}`

  return h.div([h.Class('insight')], [
    h.span([h.Class('insight-label')], ['Next to watch']),
    h.span([], [text]),
  ])
}

const rowActions = (
  row: PromoRow,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const busy = HashMap.has(model.patchingIds, row.id)

  const links: ReadonlyArray<Html> = [
    row.url
      ? h.a(
          [h.Href(row.url), h.Target('_blank'), h.Rel('noreferrer noopener')],
          ['open'],
        )
      : h.empty,
    row.proof
      ? h.a(
          [h.Href(row.proof), h.Target('_blank'), h.Rel('noreferrer noopener')],
          ['proof'],
        )
      : h.empty,
  ]

  return h.div([h.Class('row-actions')], [
    ...links,
    Button.view(
      {
        onClick: Message.ClickedCycleStatus({ id: row.id, next: nextStatus(row.status) }),
        isDisabled: busy,
        toView: attributes =>
          h.button(
            [...attributes.button, h.Class('mini-btn')],
            [busy ? '…' : 'next'],
          ),
      },
      h,
    ),
  ])
}

const stateBanner = (
  text: string,
  isError: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class(`state-banner${isError ? ' error' : ''}`),
      isError ? h.Role('alert') : h.Role('status'),
    ],
    [
      text,
      ...(isError
        ? [
            Button.view(
              {
                onClick: Message.ClickedRefresh(),
                toView: attributes =>
                  h.button(
                    [...attributes.button, h.Class('btn retry')],
                    ['Retry'],
                  ),
              },
              h,
            ),
          ]
        : []),
    ],
  )
