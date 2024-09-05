const { Readable } = require('node:stream')
const express = require('express')
const { http, HttpResponse } = require('msw')
const { setupServer } = require('msw/node')

// Enable API mocking as usual.
const server = setupServer(
  http.get('https://example.com/resource', () => {
    return HttpResponse.json([1, 2, 3])
  }),
)

server.listen({
  remote: true,
})

// Spawn a Node.js application.
const app = express()

app.get('/resource', async (req, res) => {
  const response = await fetch('https://example.com/resource')
  res.writeHead(response.status, response.statusText)
  Readable.fromWeb(response.body).pipe(res)
})

app.use('/proxy', async (req, res) => {
  const response = await fetch(req.header('location'), {
    method: req.method,
    headers: req.headers,
  })
  res.writeHead(response.status, response.statusText)

  if (response.body) {
    const reader = response.body.getReader()
    reader.read().then(function processResult(result) {
      if (result.done) {
        res.end()
        return
      }

      res.write(Buffer.from(result.value))
      reader.read().then(processResult)
    })
  } else {
    res.end()
  }
})

const httpServer = app.listen(() => {
  if (!process.send) {
    throw new Error(
      'Failed to start a test Node.js app: not spawned as a child process of the test',
    )
  }

  const address = httpServer.address()

  if (typeof address === 'string') {
    return process.send(address)
  }

  process.send(new URL(`http://localhost:${address.port}`).href)
})
