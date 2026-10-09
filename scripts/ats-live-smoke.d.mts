export interface AtsTarget {
  url: string;
  origin: string;
  host: string;
  ats: "greenhouse" | "lever" | "ashby" | "recruitee" | "workable" | "smartrecruiters" | "teamtailor" | "workday";
}

export type ValidationResult =
  | { ok: true; target: AtsTarget; reason?: never }
  | { ok: false; reason: string; target?: never };

export interface ReadOnlyRequestInput {
  target: AtsTarget;
  url: string;
  method: string;
  resourceType?: string;
  isNavigationRequest?: boolean;
  isInitialNavigation?: boolean;
  isRedirect?: boolean;
  fromUrl?: string;
}

export interface ReadOnlyGuardContext {
  route(pattern: string, handler: (route: any) => Promise<void>): Promise<void>;
  routeWebSocket(pattern: string, handler: (route: { close(code?: number, reason?: string): void }) => void): Promise<void>;
}

export function validateAtsUrl(value: unknown): ValidationResult;
export function allowsReadOnlyRequest(input: ReadOnlyRequestInput): boolean;
export function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string>;
export function createSmokeEgressResolver(
  initialHosts: string[],
  resolveAddresses?: (hostname: string) => Promise<Array<{ address: string; family: number }>>,
): {
  allow(hostname: string): unknown;
  resolve(hostname: string): Promise<Array<{ address: string; family: number }>>;
};
export function classifyPageSignals(input?: { captcha?: boolean; login?: boolean; httpStatus?: number | null }): "accessible" | "inaccessible" | "login" | "captcha";
export function installReadOnlyGuards(context: ReadOnlyGuardContext, target: AtsTarget, allowEgressHost?: (hostname: string) => unknown): Promise<{ blockedRequests: number; blockedWebSockets: number }>;
export function parseCliArgs(argv: string[]): { error?: string; help?: boolean; timeoutMs?: number; urls?: string[] };
export function runAtsLiveSmoke(
  rawUrls: string[],
  options?: {
    timeoutMs?: number;
    browserType?: { launch(options: any): Promise<any> };
    proxyFactory?: (resolveAddresses: (hostname: string) => Promise<Array<{ address: string; family: number }>>) => { listen(): Promise<string>; close(): Promise<void> };
  },
): Promise<{
  schemaVersion: number;
  mode: "read-only";
  checkedAt: string;
  results: Array<Record<string, unknown>>;
}>;
export function main(argv?: string[], output?: { write(value: string): unknown }, errorOutput?: { write(value: string): unknown }): Promise<number>;
