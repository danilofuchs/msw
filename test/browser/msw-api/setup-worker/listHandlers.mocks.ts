import { rest, graphql } from 'msw'
import { setupWorker } from 'msw/browser'

const resolver = () => void 0

const github = graphql.link('https://api.github.com')

const worker = setupWorker(
  rest.get('https://test.mswjs.io/book/:bookId', resolver),
  graphql.query('GetUser', resolver),
  graphql.mutation('UpdatePost', resolver),
  graphql.operation(resolver),
  github.query('GetRepo', resolver),
  github.operation(resolver),
)

// @ts-ignore
window.msw = {
  worker,
  rest,
  graphql,
}
