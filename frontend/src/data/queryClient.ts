import { QueryClient } from '@tanstack/react-query'

/**
 * The application's query client, and the defaults every query inherits.
 *
 * It lives in its own module so a component file exports components only, and
 * so a test can build the same client and look inside it: that is the only way
 * to see that another identity's cached page is really gone rather than merely
 * unreachable.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // One attempt per request, like the request helper. A hidden retry
        // would spend the caller's rate-limit budget and turn a real failure
        // into a longer spinner. Retry is a button.
        retry: false,
        // No polling and no background refetch. A wallet list changes when this
        // user changes it, so an automatic refetch would only add requests.
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: false,
        // Nothing protected lingers after its observer is gone. Removal on an
        // identity change is explicit; this is the backstop that keeps another
        // user's rows out of memory once their screen is gone.
        gcTime: 0,
      },
    },
  })
}
