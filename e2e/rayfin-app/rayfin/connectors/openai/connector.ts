// Sample Rayfin connector. Connectors expose external services (here a mock
// LLM endpoint) to the app's functions/data layer. Forward-looking: no Rayfin
// CLI scaffolds connectors yet, so this offline mock hand-defines one to
// exercise Cockpit.js's gated "Functions & connectors" section.
export default {
  name: "openai",
  kind: "http",
  baseUrl: "https://api.openai.com/v1",
};
