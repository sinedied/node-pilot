// Minimal ambient declaration for the Copilot extension SDK. The real package is
// provided by the GitHub Copilot app at runtime and is not installed from npm, so
// this shim lets `tsc` type-check `src/extension.ts` in CI (and anywhere the app
// isn't present) without pulling in the full SDK. Only the surface Cockpit.js uses
// is declared; keep it loose on purpose.
declare module "@github/copilot-sdk/extension" {
  export interface CanvasOpenContext {
    instanceId: string;
    session?: { workingDirectory?: string };
    input?: unknown;
  }

  export interface CanvasCloseContext {
    instanceId: string;
  }

  export interface CanvasActionContext {
    input?: Record<string, unknown>;
    session?: { workingDirectory?: string };
  }

  export interface CanvasActionDefinition {
    name: string;
    description?: string;
    inputSchema?: unknown;
    handler: (ctx: CanvasActionContext) => unknown | Promise<unknown>;
  }

  export interface CanvasOpenResult {
    title?: string;
    url: string;
    status?: string;
  }

  export interface CanvasOptions {
    id: string;
    displayName: string;
    description: string;
    actions?: CanvasActionDefinition[];
    open: (ctx: CanvasOpenContext) => CanvasOpenResult | Promise<CanvasOpenResult>;
    onClose?: (ctx: CanvasCloseContext) => void | Promise<void>;
  }

  export function createCanvas(options: CanvasOptions): unknown;

  export interface CopilotSession {
    log(message: string, options?: { level?: string }): Promise<void>;
    send(message: {
      prompt: string;
      attachments?: Array<{
        type: "file" | "directory" | "selection" | "blob";
        data?: string;
        mimeType?: string;
        displayName?: string;
        path?: string;
      }>;
      mode?: "enqueue" | "immediate";
    }): Promise<void>;
  }

  export interface JoinSessionConfig {
    canvases?: unknown[];
  }

  export function joinSession(config?: JoinSessionConfig): Promise<CopilotSession>;
}
