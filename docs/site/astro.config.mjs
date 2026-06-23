import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Cockpit.js dogfoods its own Dev and Build lanes with this Astro + Starlight
// docs site. It is a self-contained Astro project rooted at docs/site/ (run via
// `astro --root docs/site`) so it never touches the extension's own src/
// (TypeScript backend) or public/ (canvas UI).
export default defineConfig({
  site: "https://sinedied.github.io/node-pilot",
  integrations: [
    starlight({
      title: "Cockpit.js",
      description:
        "A GitHub Copilot canvas extension that drives the JavaScript / Node.js / web inner loop from the Copilot app side panel.",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/sinedied/node-pilot",
        },
      ],
      sidebar: [
        { label: "Features", slug: "features" },
        { label: "Install & usage", slug: "install" },
        { label: "Architecture", slug: "architecture" },
      ],
    }),
  ],
});
