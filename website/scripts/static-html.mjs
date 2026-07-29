export function stripClientRuntime(html) {
  return html
    .replace(/<link\b[^>]*>/gi, (tag) =>
      /\brel=(['"])modulepreload\1/i.test(tag) ? "" : tag,
    )
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) =>
      /__VINEXT_RSC_|\bid=(['"])_R_\1/i.test(tag) ? "" : tag,
    );
}
