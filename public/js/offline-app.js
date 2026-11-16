/*
 * Small client-side fixes for the offline site, loaded on every page from the footer partial.
 *
 * After a category filter is applied with AJAX, set the address bar to the canonical URL of
 * the filtered page (the server puts it in the response's `.permalink` input), so refresh,
 * back/forward and shared links reproduce the same filtered view.
 */
(function () {
  if (!window.jQuery) return;

  // Header cart badge: show the visitor's real item count (pages are rendered without it).
  jQuery.getJSON('/api/cart').done(function (cart) {
    var n = cart && cart.count || 0;
    var label = 'My Cart, ' + n + ' Item' + (n === 1 ? '' : 's');
    jQuery('.minicart .minicart-quantity').text(n).toggleClass('d-none', n === 0);
    jQuery('.minicart .minicart-link').attr({ title: label, 'aria-label': label });
  });
  jQuery(document).ajaxSuccess(function (event, xhr, settings) {
    if (!/Search-ShowAjax/.test(settings.url || '')) return;
    var match = /class="permalink" value="([^"]*)"/.exec(xhr.responseText || '');
    if (!match) return;
    var url = match[1].replace(/&amp;/g, '&');
    if (url.charAt(0) === '/') window.history.replaceState(null, '', url);

    // The sort <select> isn't part of the sections search.js swaps in, so copy the
    // filter-aware sort URLs from the response; re-sorting then keeps the active filters.
    var $response = jQuery('<div>').append(jQuery.parseHTML(xhr.responseText || ''));
    $response.find('select[name="sort-order"] option').each(function () {
      var cls = (this.className || '').split(/\s+/)[0];
      if (cls) jQuery('select[name="sort-order"] option.' + cls).val(this.value);
    });
  });
})();
