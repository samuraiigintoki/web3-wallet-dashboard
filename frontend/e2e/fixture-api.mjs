// Fixture API for the browser-evidence job. One route, labelled fixture data,
// no chain. Test infrastructure, never imported by application code.
import { createServer } from 'node:http'

const FIXTURE_EMAIL =
  'alexandrina.constantinopoulos-whitfield.the.third@very-long-identity-name.example.com'

const user = {
  id: 5,
  email: FIXTURE_EMAIL,
  createdAt: '2026-10-06T12:00:00Z',
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')

  if (url.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
    return
  }

  if (url.pathname === '/api/v1/users/me' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: user }))
    return
  }

  if (url.pathname === '/api/v1/auth/logout' && request.method === 'POST') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: { message: 'Signed out.' } }))
    return
  }

  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such route' } }))
})

server.listen(8099, '127.0.0.1', () => {
  console.log('fixture api on 8099')
})
