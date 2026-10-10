# Samples

Files for trying Logline without an app of your own.

| Sample | Try it with |
| --- | --- |
| [demo-logs.jsonl](demo-logs.jsonl) | **Logline: Import Logs**: JSON logs from several services, with errors, latency, and stack traces. |
| [follow-demo.log](follow-demo.log) | **Logline: Follow Log File**: plain text, logfmt, and a stack trace. Append lines to see them arrive. |
| [compose-demo.log](compose-demo.log) | **Logline: Import Logs**: `docker compose logs --timestamps` output from an `api`, `worker`, and `db` service, which Logline splits into one source each. |
| [checkout-demo](checkout-demo) | Open the folder in VS Code (Node.js 18 or later). See below. |

## Checkout demo

A small Node.js app with no dependencies. It writes JSON logs like pino and, while the Logline OpenTelemetry receiver runs, sends spans for each request across a `checkout-api`, `inventory`, and `payments` service, plus an order counter and a checkout duration histogram as metrics. It is the app shown in the README demo.

1. Open `samples/checkout-demo` as a workspace folder.
2. Choose **More actions → Start OpenTelemetry receiver** in the Logs panel.
3. Select **Checkout API** in the source picker and choose **Run**, or press F5 on `src/server.js` to capture it from the debugger.

Then try:

- **Traces** shows each checkout request; every seventh order is declined, so its trace is marked as failed. Its waterfall shows where the time went.
- **Metrics** shows orders per second by outcome and the p95 checkout duration.
- In a git repository, edit a log statement such as `payment failed for order` and run again: **My changes** shows only the logs from your edit.
- Open `src/checkout.js`. Log lenses count each statement's hits, and log doctor marks `auth ok` (it logs a bearer token) and `payment failed for order` (it drops the caught `err`). Press Ctrl+. on either line for fixes.
- Expand a `payment failed for order` event and choose **Break when this logs again**, then debug the app with F5.

The token in `src/server.js` is a made-up example; it is not valid anywhere.
