import { useLocation } from 'react-router'

/** Exposes the router's current path so a redirect can be asserted. */
export function LocationProbe() {
  const location = useLocation()

  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>
}
