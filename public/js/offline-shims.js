/*
 * Offline shims.
 * The live site loads Salesforce Commerce Cloud analytics (dwac / dwanalytics), which this
 * offline copy removes. Inline snippets on product, category and recipe pages still call
 * `dw.ac.*`, so provide a no-op stand-in that swallows every call.
 */
(function () {
  function noop() { return noopProxy; }
  var noopProxy = typeof Proxy === 'function'
    ? new Proxy(noop, { get: function (t, k) { return k === Symbol.toPrimitive ? function () { return ''; } : noopProxy; }, apply: function () { return noopProxy; } })
    : noop;
  if (!window.dw) window.dw = { ac: noopProxy };
  if (!window.dataLayer) window.dataLayer = [];
})();
