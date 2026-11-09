/** Which window this renderer is: the analysis view from the URL
 *  (``?view=batch_analysis`` …), or ``main``. The store's cross-window
 *  broadcasts carry it as ``src`` so a window can ignore its own echoes. */
export const WINDOW_KIND: string =
  new URLSearchParams(window.location.search).get('view') ?? 'main'
