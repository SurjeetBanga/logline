# Search your logs

Type in the Logs panel's search box and press Enter. Each term becomes a chip you can click to change.

| Try | Finds |
| --- | --- |
| `level:error` | Errors |
| `status:5xx last:15m` | Server errors in the last 15 minutes |
| `"payment failed" -retry` | That phrase, without retries |

Click a row to read its fields and stack trace, open the line of code that logged it, and see the logs around it.
