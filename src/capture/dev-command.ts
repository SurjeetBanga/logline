/**
 * Whether a terminal command starts something long-running that logs: a dev
 * server, an app, or a set of containers. Used to offer capture at the moment
 * it would have helped; a miss only means no offer.
 */
const SCRIPT = '(?:dev|start|serve|server|watch|preview)(?::[\\w.-]+)?';
const PATTERNS: RegExp[] = [
  // Package scripts: npm run dev, pnpm dev, yarn start:api, bun run serve.
  new RegExp(`^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?${SCRIPT}(?:\\s|$)`),
  /^(?:npx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|bunx)\s+(?:vite|next|nuxt|nodemon|tsx|ts-node|astro|remix|ng|wrangler)\b/,
  /^(?:vite|nodemon|ts-node-dev)(?:\s|$)/,
  /^(?:next|nuxt|astro|remix)\s+dev\b/,
  /^ng\s+serve\b/,
  /^tsx\s+watch\b/,
  /^(?:node|bun|deno)\s+(?:run\s+)?(?:--[\w=-]+\s+)*\S*(?:server|index|app|main)\.[cm]?[jt]s\b/,
  /^(?:python[\d.]*|py)\s+(?:-m\s+)?(?:uvicorn|gunicorn|flask|hypercorn|daphne|http\.server)\b/,
  /^(?:python[\d.]*|py)\s+\S*manage\.py\s+runserver\b/,
  /^(?:uvicorn|gunicorn|hypercorn|daphne)\s/,
  /^(?:flask|fastapi)\s+(?:run|dev)\b/,
  /^(?:poetry|uv|pipenv|hatch)\s+run\s+(?:uvicorn|gunicorn|flask|fastapi|python)\b/,
  /^(?:bundle\s+exec\s+)?(?:rails|bin\/rails)\s+(?:s|server)\b/,
  /^(?:bin\/dev|foreman\s+start|overmind\s+start)(?:\s|$)/,
  /^go\s+run\b/,
  /^(?:air|cargo\s+(?:run|watch))(?:\s|$)/,
  /^dotnet\s+(?:run|watch)\b/,
  /^(?:\.\/)?(?:mvnw?|gradlew?)\s+\S*(?:spring-boot:run|bootRun|quarkus:dev|quarkusDev)\b/,
  /^php\s+artisan\s+serve\b/,
  /^mix\s+phx\.server\b/,
  /^docker[\s-]compose\s+(?:-\S+\s+\S+\s+)*up\b/,
  /^(?:make|just|task)\s+(?:dev|serve|start|run|up)(?:\s|$)/,
];

/** Longer than any command someone types to start a server; nothing longer is examined. */
const MAX_COMMAND = 2000;
const ASSIGNMENT = /^\w+=(?:"[^"]*"|'[^']*'|\S*)\s+/;

/**
 * The command without what only sets its environment: an `env` or `cross-env`
 * wrapper, `dotenv … --`, and leading `VAR=value` assignments. Each step takes
 * one piece off the front, so the time taken grows with the length only.
 */
function withoutEnvironment(commandLine: string): string {
  let rest = commandLine.trim();
  const wrapper = /^(?:env|cross-env)\s+/.exec(rest);
  if (wrapper) rest = rest.slice(wrapper[0].length);
  else if (/^dotenv\s/.test(rest)) {
    const separator = rest.indexOf(' -- ');
    if (separator !== -1) rest = rest.slice(separator + 4).trimStart();
  }
  for (let assignment = ASSIGNMENT.exec(rest); assignment; assignment = ASSIGNMENT.exec(rest))
    rest = rest.slice(assignment[0].length);
  return rest;
}

export function looksLikeDevServer(commandLine: string): boolean {
  if (commandLine.length > MAX_COMMAND) return false;
  const command = withoutEnvironment(commandLine);
  return PATTERNS.some((pattern) => pattern.test(command));
}

/** Runs of a program or a test suite, whose output is worth searching even though nothing stays up. */
const RUN_PATTERNS: RegExp[] = [
  /^(?:python[\d.]*|py)\s+(?:-[\w.]+\s+)*[^\s-]\S*\.pyw?\b/,
  /^(?:python[\d.]*|py)\s+-m\s+(?:pytest|unittest)\b/,
  /^(?:node|bun|deno)\s+(?:run\s+)?(?:--[\w=:.-]+\s+)*[^\s-]\S*\.[cm]?[jt]sx?\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w.-]+)?(?:\s|$)/,
  /^npm\s+t(?:\s|$)/,
  /^(?:npx\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+dlx\s+|bunx\s+)?(?:jest|vitest|mocha|playwright\s+test)(?:\s|$)/,
  /^(?:pytest|py\.test|rspec|bundle\s+exec\s+rspec)(?:\s|$)/,
  /^(?:poetry|uv|pipenv|hatch)\s+run\s+(?:pytest|python)\b/,
  /^(?:go|cargo|dotnet|mix|deno)\s+test\b/,
  /^php\s+artisan\s+test\b/,
  /^(?:\.[\\/])?(?:mvnw?|gradlew?)(?:\.cmd|\.bat)?\s+(?:\S+\s+)*?(?:test|check|run|bootRun)\b/,
];

/**
 * Whether a terminal command runs something whose output is worth capturing:
 * a dev server, or a program or test suite. Builds, installs, and shell
 * commands are not; a miss only means no offer.
 */
export function looksLikeProgramRun(commandLine: string): boolean {
  if (commandLine.length > MAX_COMMAND) return false;
  if (looksLikeDevServer(commandLine)) return true;
  const command = withoutEnvironment(commandLine);
  return RUN_PATTERNS.some((pattern) => pattern.test(command));
}
