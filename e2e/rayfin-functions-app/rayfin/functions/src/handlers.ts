// Backend function handlers, implemented with the Azure Functions Node.js v4
// programming model (Rayfin runs functions on the Azure Functions host — locally
// on RAYFIN_FUNCTIONS_PORT, 7071 by default). Each handler is invoked from the
// frontend via `client.functions.<name>.invoke(...)`; the input/output contracts
// are declared in ./types.ts (AppFunctionsSchema).
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';

async function helloWorld(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const { firstName, lastName } = (await req.json()) as { firstName: string; lastName?: string };
  const name = [firstName, lastName].filter(Boolean).join(' ');
  return { jsonBody: `Hello, ${name}!` };
}

async function add(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const { a, b } = (await req.json()) as { a: number; b: number };
  return { jsonBody: a + b };
}

async function summarize(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const { text, maxWords = 20 } = (await req.json()) as { text: string; maxWords?: number };
  const summary = text.split(/\s+/).slice(0, maxWords).join(' ');
  return { jsonBody: { summary } };
}

app.http('helloWorld', { methods: ['POST'], authLevel: 'anonymous', handler: helloWorld });
app.http('add', { methods: ['POST'], authLevel: 'anonymous', handler: add });
app.http('summarize', { methods: ['POST'], authLevel: 'anonymous', handler: summarize });
