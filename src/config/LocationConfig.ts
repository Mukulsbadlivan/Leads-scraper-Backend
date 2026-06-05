export function getLocationSearchString(
  country?: string,
  state?: string,
  city?: string
): string {
  return [city, state, country]
    .filter(Boolean)
    .join(", ");
}