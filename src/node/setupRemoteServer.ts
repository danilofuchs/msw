import * as http from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { invariant } from 'outvariant'
import { Server as WebSocketServer } from 'socket.io'
import { Socket, io } from 'socket.io-client'
import { Emitter } from 'strict-event-emitter'
import { createRequestId } from '@mswjs/interceptors'
import { DeferredPromise } from '@open-draft/deferred-promise'
import { SetupApi } from '~/core/SetupApi'
import type { RequestHandler } from '~/core/handlers/RequestHandler'
import type { WebSocketHandler } from '~/core/handlers/WebSocketHandler'
import { handleRequest } from '~/core/utils/handleRequest'
import { isHandlerKind } from '~/core/utils/internal/isHandlerKind'
import {
  type SerializedRequest,
  type SerializedResponse,
  deserializeRequest,
  serializeResponse,
} from '~/core/utils/request/serializeUtils'
import type {
  LifeCycleEventEmitter,
  LifeCycleEventsMap,
} from '~/core/sharedOptions'
import { devUtils } from '~/core/utils/internal/devUtils'
import {
  type SerializedLifeCycleEventsMap,
  deserializeEventPayload,
} from '~/core/utils/internal/emitterUtils'
import {
  REQUEST_INTENTION_HEADER_NAME,
  RequestIntention,
} from '~/core/utils/internal/requestUtils'
import { AsyncHandlersController } from './SetupServerApi'

export const MSW_REMOTE_SERVER_PORT = 56957

const store = new AsyncLocalStorage<{
  contextId: string
  initialHandlers: Array<RequestHandler | WebSocketHandler>
  handlers: Array<RequestHandler | WebSocketHandler>
}>()

const kSyncServer = Symbol('kSyncServer')
type SyncServerType = WebSocketServer<SyncServerEventsMap> | undefined

/**
 * Enables API mocking in a remote Node.js process.
 */
export function setupRemoteServer(
  ...handlers: Array<RequestHandler | WebSocketHandler>
): SetupRemoteServerApi {
  return new SetupRemoteServerApi(handlers)
}

export interface SetupRemoteServerListenOptions {
  /**
   * Custom port number to synchronize this this `setupRemoteServer`
   * with the regular `setupServer`.
   * @default 56957
   */
  port?: number
}

export interface SetupRemoteServer {
  events: LifeCycleEventEmitter<LifeCycleEventsMap>
  listen: (options: SetupRemoteServerListenOptions) => Promise<void>
  boundary: <Args extends Array<any>, R>(
    callback: (...args: Args) => R,
  ) => (...args: Args) => R
  get contextId(): string
  close: () => Promise<void>
}

export interface SyncServerEventsMap {
  request: (args: {
    serializedRequest: SerializedRequest
    requestId: string
  }) => Promise<void> | void

  response: (args: {
    serializedResponse?: SerializedResponse
  }) => Promise<void> | void

  lifeCycleEventForward: <Type extends keyof SerializedLifeCycleEventsMap>(
    type: Type,
    args: SerializedLifeCycleEventsMap[Type],
  ) => void
}

export class SetupRemoteServerApi
  extends SetupApi<LifeCycleEventsMap>
  implements SetupRemoteServer
{
  constructor(handlers: Array<RequestHandler | WebSocketHandler>) {
    super(...handlers)

    this.handlersController = new AsyncHandlersController({
      store,
      initialHandlers: handlers,
    })
  }

  get contextId(): string {
    const context = store.getStore()

    invariant(
      context != null,
      'Failed to get "contextId" on "SetupRemoteServerApi": no context found. Did you forget to wrap this closure in `remote.boundary()`?',
    )

    return context.contextId
  }

  public async listen(
    options: SetupRemoteServerListenOptions = {},
  ): Promise<void> {
    const port = options.port || MSW_REMOTE_SERVER_PORT

    invariant(
      typeof port === 'number',
      'Failed to initialize remote server: expected the "port" option to be a valid port number but got "%s". Make sure it is the same port number you provide as the "remotePort" option to "server.listen()" in your application.',
      port,
    )

    const dummyEmitter = new Emitter<LifeCycleEventsMap>()
    const wssUrl = createWebSocketServerUrl(port)
    const server = await createSyncServer(wssUrl)

    server.removeAllListeners()

    process
      .once('SIGTERM', () => closeSyncServer(server))
      .once('SIGINT', () => closeSyncServer(server))

    server.on('connection', async (socket) => {
      socket.on('request', async ({ requestId, serializedRequest }) => {
        const request = deserializeRequest(serializedRequest)
        const response = await handleRequest(
          request,
          requestId,
          this.handlersController
            .currentHandlers()
            .filter(isHandlerKind('RequestHandler')),
          /**
           * @todo Support resolve options from the `.listen()` call.
           */
          { onUnhandledRequest() {} },
          dummyEmitter,
        )

        socket.emit('response', {
          serializedResponse: response
            ? await serializeResponse(response)
            : undefined,
        })
      })

      socket.on('lifeCycleEventForward', async (type, args) => {
        const deserializedArgs = await deserializeEventPayload(args)
        this.emitter.emit(type, deserializedArgs as any)
      })
    })
  }

  public boundary<Args extends Array<any>, R>(
    callback: (...args: Args) => R,
  ): (...args: Args) => R {
    const contextId = createRequestId()

    return (...args: Args): R => {
      return store.run(
        {
          contextId,
          initialHandlers: this.handlersController.currentHandlers(),
          handlers: [],
        },
        callback,
        ...args,
      )
    }
  }

  public async close(): Promise<void> {
    store.disable()

    const syncServer = Reflect.get(globalThis, kSyncServer) as SyncServerType

    invariant(
      syncServer,
      devUtils.formatMessage(
        'Failed to close a remote server: no server is running. Did you forget to call and await ".listen()"?',
      ),
    )

    await closeSyncServer(syncServer)
  }
}

/**
 * Creates an internal WebSocket sync server.
 */
async function createSyncServer(
  url: URL,
): Promise<WebSocketServer<SyncServerEventsMap>> {
  const syncServer = Reflect.get(globalThis, kSyncServer) as SyncServerType

  // Reuse the existing WebSocket server reference if it exists.
  // It persists on the global scope between hot updates.
  if (syncServer) {
    return syncServer
  }

  const serverReadyPromise = new DeferredPromise<
    WebSocketServer<SyncServerEventsMap>
  >()

  const httpServer = http.createServer()
  const ws = new WebSocketServer<SyncServerEventsMap>(httpServer, {
    transports: ['websocket'],
    cors: {
      origin: '*',
      methods: ['HEAD', 'GET', 'POST'],
    },
  })

  httpServer.listen(+url.port, url.hostname, () => {
    serverReadyPromise.resolve(ws)
  })

  httpServer.on('error', (error) => {
    serverReadyPromise.reject(error)
  })

  return serverReadyPromise.then((ws) => {
    Object.defineProperty(globalThis, kSyncServer, {
      value: ws,
    })
    return ws
  })
}

async function closeSyncServer(server: WebSocketServer): Promise<void> {
  const serverClosePromise = new DeferredPromise<void>()

  server.close((error) => {
    if (error) {
      return serverClosePromise.reject(error)
    }
    serverClosePromise.resolve()
  })

  return serverClosePromise.then(() => {
    Reflect.deleteProperty(globalThis, kSyncServer)
  })
}

function createWebSocketServerUrl(port: number): URL {
  const url = new URL('http://localhost')
  url.port = port.toString()
  return url
}

/**
 * Creates a WebSocket client connected to the internal
 * WebSocket sync server of MSW.
 */
export async function createSyncClient(args: { port: number }) {
  const connectionPromise = new DeferredPromise<Socket<SyncServerEventsMap>>()
  const url = createWebSocketServerUrl(args.port)
  const socket = io(url.href, {
    transports: ['websocket'],
    // Keep a low timeout and no retry logic because
    // the user is expected to enable remote interception
    // before the actual application with "setupServer".
    timeout: 200,
    reconnection: false,
    extraHeaders: {
      // Bypass the internal WebSocket connection requests
      // to exclude them from the request lookup altogether.
      // This prevents MSW from treating these requests as unhandled.
      [REQUEST_INTENTION_HEADER_NAME]: RequestIntention.bypass,
    },
  })

  socket.on('connect', () => {
    connectionPromise.resolve(socket)
  })

  socket.io.once('error', (error) => {
    connectionPromise.reject(error)
  })

  return connectionPromise
}