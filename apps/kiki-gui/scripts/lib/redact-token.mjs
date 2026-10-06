/**
 * Credential redaction for the real-harness proof scripts.
 *
 * The GUI bootstraps from the query string, so the server token rides every
 * page URL. Anything that prints a URL — a Playwright call log, an assertion
 * message, an unhandled rejection — can therefore put the credential in a
 * terminal or a CI log. This is the single place that removes it.
 *
 * Both the raw value and its percent-encoded form are replaced: a URL that
 * carried it may reach a log in either shape, and a half-redacted URL is still
 * a leak.
 */

export function createRedactor(token) {
  const forms = [...new Set([token, encodeURIComponent(token), encodeURI(token)])].filter((form) => form !== '');
  return (value) => {
    let out = String(value);
    for (const form of forms) out = out.split(form).join('<redacted>');
    return out;
  };
}
