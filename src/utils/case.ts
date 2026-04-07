export function camelToSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

export function snakeToCamel(input: string): string {
  return input.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

export function kebabToCamel(input: string): string {
  return input.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

export function kebabToSnake(input: string): string {
  return input.replace(/-/g, "_");
}

export function humanizeFieldName(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
