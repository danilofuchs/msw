import { setupWorker } from 'msw/browser'

const worker = setupWorker()

worker.start({
  serviceWorker: {
    url: '/mockServiceWorker.js',
  },
})
