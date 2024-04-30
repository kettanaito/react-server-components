import { stream } from 'hono/streaming'
import { Writable } from 'node:stream'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import busboy from 'busboy'
import closeWithGrace from 'close-with-grace'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { createElement as h } from 'react'
import {
	renderToPipeableStream,
	decodeReplyFromBusboy,
} from 'react-server-dom-esm/server'
import { App } from '../src/app.js'
import { shipDataStorage } from './async-storage.js'

const PORT = process.env.PORT || 3000

const app = new Hono({ strict: false })

app.use(compress())

app.use(serveStatic({ root: './public/', index: false }))
app.use(
	'/js/src/*',
	serveStatic({
		root: './src',
		index: false,
		rewriteRequestPath(path) {
			return path.replace(/^\/js\/src/, '')
		},
	}),
)

// This just cleans up the URL if the search ever gets cleared... Not important
// for RSCs... Just ... I just can't help myself. I like URLs clean.
app.use(({ req, redirect }, next) => {
	if (req.query.search === '') {
		const searchParams = new URLSearchParams()
		searchParams.delete('search')
		const location = [req.path, searchParams.toString()]
			.filter(Boolean)
			.join('?')
		return redirect(location, 302)
	}
	return next()
})

const moduleBasePath = new URL('../src', import.meta.url).href

async function renderApp(context, returnValue) {
	const { req, res } = context
	try {
		const shipId = req.param('shipId') || null
		const search = req.query('search') || ''
		const data = { shipId, search }
		return stream(context, async stream => {
			await new Promise(resolve =>
				shipDataStorage.run(data, async () => {
					const root = h(App)
					const payload = { root, returnValue }
					const { pipe } = renderToPipeableStream(payload, moduleBasePath)
					const writable = new Writable({
						write(chunk, _encoding, callback) {
							stream.write(chunk)
							callback()
						},
					})
					pipe(writable)
					writable.on('close', () => {
						stream.close()
						resolve()
					})
				}),
			)
		})
	} catch (error) {
		console.error(error)
		res.status(500).json({ error: error.message })
	}
}

app.get('/rsc/:shipId?', async context => {
	const app = await renderApp(context, null)
	return app
})

app.post('/action/:shipId?', async context => {
	const serverReference = context.req.header('rsc-action')
	const [filepath, name] = serverReference.split('#')
	const action = (await import(filepath))[name]
	// Validate that this is actually a function we intended to expose and
	// not the client trying to invoke arbitrary functions. In a real app,
	// you'd have a manifest verifying this before even importing it.
	if (action.$$typeof !== Symbol.for('react.server.reference')) {
		throw new Error('Invalid action')
	}

	const bb = busboy({
		headers: Object.fromEntries(context.req.raw.headers.entries()),
	})
	const reply = decodeReplyFromBusboy(bb, moduleBasePath)
	Writable.fromWeb(context.req.raw.body).pipe(bb)
	const args = await reply
	const result = await action(...args)

	await renderApp(res, result)
})

app.get('/:shipId?', serveStatic({ root: 'public', path: 'index.html' }))

const server = serve({ port: PORT, fetch: app.fetch }, () => {
	console.log(`🚀  We have liftoff!`)
	console.log(`http://localhost:${PORT}`)
})

closeWithGrace(async ({ signal, err }) => {
	if (err) console.error('Shutting down server due to error', err)
	else console.log('Shutting down server due to signal', signal)

	await new Promise(resolve => server.close(resolve))
	process.exit()
})
