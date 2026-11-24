import { Runtime } from 'foldkit'

import { Model, init, subscriptions, update, view } from './main'
import { Message } from './message'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById('root'),
  devTools: {
    Message,
  },
})

Runtime.run(application)
