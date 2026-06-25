// Sample Rayfin function. Functions are deployed alongside the data/auth APIs
// and can be scaffolded/typed via `rayfin functions …`.
export default async function hello(req: { query: Record<string, string> }) {
  const name = req.query.name ?? "world";
  return { status: 200, body: { message: `Hello, ${name}!` } };
}
