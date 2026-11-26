declare module "html-to-text" {
  export function htmlToText(
    html: string,
    options?: {
      limits?: { maxDepth?: number };
      selectors?: { selector: string; format: string; options?: Record<string, unknown> }[];
    },
  ): string;
}
